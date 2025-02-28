import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Server } from 'socket.io';
import { availableParallelism } from 'node:os';
import cluster from 'node:cluster';
import { createAdapter, setupPrimary } from '@socket.io/cluster-adapter';
import { MongoClient, ServerApiVersion } from 'mongodb';
import bodyParser from 'body-parser';
import cors from 'cors';
import session from 'express-session';
import sharedSession from 'express-socket.io-session';
import dotenv from 'dotenv';
dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));

// MongoDB Connection URI
const uri = process.env.MONGODB_URI;

if (cluster.isPrimary) {
    const numCPUs = availableParallelism();
    console.log(`Primary ${process.pid} is running`);
    console.log(`Starting ${numCPUs} workers...`);

    for (let i = 0; i < numCPUs; i++) {
        cluster.fork({
            PORT: 3000 + i
        });
    }

    setupPrimary();

    cluster.on('exit', (worker, code, signal) => {
        console.log(`Worker ${worker.process.pid} died`);
        cluster.fork({
            PORT: worker.process.env.PORT
        });
    });
} else {
    const startServer = async () => {
        // Create a MongoClient
        const client = new MongoClient(uri, {
            serverApi: {
                version: ServerApiVersion.v1,
                strict: true,
                deprecationErrors: true,
            }
        });

        try {
            // Connect to MongoDB
            await client.connect();
            console.log("Connected to MongoDB");

            // Reference to database and collections
            const db = client.db("chitchat");
            const usersCollection = db.collection("users");
            const messagesCollection = db.collection("messages");

            // Create indexes for performance
            await usersCollection.createIndex({ username: 1 }, { unique: true });
            await messagesCollection.createIndex({ client_offset: 1 }, { unique: true });

            const app = express();
            const server = createServer(app);
            const io = new Server(server, {
                connectionStateRecovery: {},
                adapter: createAdapter(),
                cors: {
                    origin: [process.env.FRONTEND_URL, 'http://localhost:5173'],
                    credentials: true
                }
            });

            // Middleware
            //app.use(cors());
            // Update your CORS configuration
            app.use(cors({
                origin: [process.env.FRONTEND_URL, 'http://localhost:5173'], // Add your frontend URLs
                credentials: true // Enable credentials if using sessions
            }));
            app.use(bodyParser.json());
            app.use(express.static(join(__dirname, '/public')));
            // app.use(express.static(join(__dirname, '/public/login')));

            app.get("/", (req, res) => {
                res.sendFile(`${__dirname}/public/login/index.html`)
            })

            // Create Express session middleware
            const sessionMiddleware = session({
                secret: process.env.SESSION_SECRET,
                resave: false,
                saveUninitialized: true,
                cookie: { secure: false }
            });

            // Use session middleware in Express
            app.use(sessionMiddleware);

            // Share session with Socket.IO
            io.use((socket, next) => {
                sessionMiddleware(socket.request, {}, next);
            });

            // Signup route
            app.post('/signup', async (req, res) => {
                const { username, password } = req.body;
                if (!username || !password) {
                    return res.json({ success: false, message: "Username and password are required!" });
                }

                try {
                    await usersCollection.insertOne({ username, password });
                    res.json({ success: true, message: "Signup successful!" });
                } catch (err) {
                    // Duplicate key error
                    if (err.code === 11000) {
                        return res.json({ success: false, message: "Username already taken!" });
                    }
                    console.error("Signup error:", err);
                    res.json({ success: false, message: "Error creating account!" });
                }
            });

            // Login route
            app.post('/login', async (req, res) => {
                const { username, password } = req.body;
                if (!username || !password) {
                    return res.json({ success: false, message: "Please fill up both fields!" });
                }

                try {
                    const user = await usersCollection.findOne({ username, password });
                    if (user) {
                        req.session.user = { id: user._id.toString(), username: user.username };
                        res.json({ success: true, message: "Login successful!" });
                    } else {
                        res.json({ success: false, message: "Incorrect Credentials!" });
                    }
                } catch (err) {
                    console.error("Login error:", err);
                    res.json({ success: false, message: "Error during login!" });
                }
            });

            // Logout route
            app.post('/logout', (req, res) => {
                req.session.destroy((err) => {
                    if (err) {
                        return res.json({ success: false, message: "Logout failed!" });
                    }
                    res.json({ success: true, message: "Logged out successfully!" });
                });
            });

            // Check authentication
            app.get('/auth/user', (req, res) => {
                if (req.session.user) {
                    res.json({ loggedIn: true, username: req.session.user.username });
                } else {
                    res.json({ loggedIn: false });
                }
            });

            // Check login status
            app.get('/check-auth', (req, res) => {
                if (req.session.user) {
                    res.json({ loggedIn: true, user: req.session.user });
                } else {
                    res.json({ loggedIn: false });
                }
            });

            // Change password route
            app.post('/change-password', async (req, res) => {
                if (!req.session.user) {
                    return res.json({ success: false, message: "Not authenticated!" });
                }

                const { currentPassword, newPassword } = req.body;
                if (!currentPassword || !newPassword) {
                    return res.json({ success: false, message: "Both current and new password are required!" });
                }

                try {
                    // Check current password
                    const user = await usersCollection.findOne({
                        username: req.session.user.username,
                        password: currentPassword
                    });

                    if (!user) {
                        return res.json({ success: false, message: "Current password is incorrect!" });
                    }

                    // Update password
                    await usersCollection.updateOne(
                        { username: req.session.user.username },
                        { $set: { password: newPassword } }
                    );

                    res.json({ success: true, message: "Password changed successfully!" });
                } catch (err) {
                    console.error("Password change error:", err);
                    res.json({ success: false, message: "Error changing password!" });
                }
            });

            // Socket.IO connection handling
            io.on('connection', async (socket) => {
                console.log(`New client connected: ${socket.id}`);

                socket.on('disconnect', () => {
                    console.log(`Client disconnected: ${socket.id}`);
                });

                socket.on('chat message', async (msg, clientOffset, callback) => {
                    if (!socket.request.session || !socket.request.session.user) {
                        console.warn('Unauthorized user attempted to send a message.');
                        return;
                    }

                    const username = socket.request.session.user.username;
                    try {
                        const result = await messagesCollection.insertOne({
                            username,
                            content: msg,
                            client_offset: clientOffset,
                            created_at: new Date()
                        });

                        io.emit('chat message', { username, message: msg }, result.insertedId.toString());
                        callback();
                    } catch (e) {
                        // Skip duplicate message errors (from retries)
                        if (e.code !== 11000) {
                            console.error('Database insert error:', e);
                        }
                    }
                });

                if (!socket.recovered) {
                    try {
                        // Convert serverOffset to ObjectId if it exists
                        let query = {};
                        if (socket.handshake.auth.serverOffset) {
                            // If using ObjectId for tracking, you'll need to modify this logic
                            // For simplicity, we're using the insertedId string representation in this example
                            const lastId = socket.handshake.auth.serverOffset;
                            // This would depend on how you're tracking message IDs
                            query = { _id: { $gt: lastId } };
                        }

                        const cursor = messagesCollection.find(query).sort({ created_at: 1 });
                        await cursor.forEach(doc => {
                            socket.emit('chat message',
                                { username: doc.username, message: doc.content },
                                doc._id.toString()
                            );
                        });
                    } catch (e) {
                        console.error('Recovery error:', e);
                    }
                }
            });

            const port = process.env.PORT || 3000;
            server.listen(port, () => {
                console.log(`Worker ${process.pid} started - Server running at http://localhost:${port}`);
            });

            // Handle application shutdown
            process.on('SIGINT', async () => {
                await client.close();
                console.log('MongoDB connection closed');
                process.exit(0);
            });

        } catch (err) {
            console.error('MongoDB connection error:', err);
            process.exit(1);
        }
    };

    startServer().catch(err => {
        console.error('Failed to start server:', err);
        process.exit(1);
    });
}