const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

// ==========================================
// 1. ABSOLUTE CORS & PREFLIGHT FIX (সবার উপরে থাকবে)
// ==========================================
app.use(cors({
    origin: true, // এটি সব অরিজিনকে পারমিশন দিবে
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']
}));

// ম্যানুয়াল হেডার ইনজেকশন মিডলওয়্যার (মাস্টার ফিক্স)
app.use((req, res, next) => {
    const origin = req.headers.origin;
    res.header('Access-Control-Allow-Origin', origin || '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.header('Access-Control-Allow-Credentials', 'true');
    
    // OPTIONS রিকোয়েস্ট আসলে সাথে সাথে সাকসেস পাঠানো
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json());

// --- MongoDB Connection ---
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ay91vcf.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
});

async function run() {
    try {
        const db = client.db("promptlyDB");
        const usersCollection = db.collection("users");
        const promptsCollection = db.collection("prompts");
        const reviewsCollection = db.collection("reviews");
        const bookmarksCollection = db.collection("bookmarks");
        const paymentsCollection = db.collection("payments");
        const reportsCollection = db.collection("reports");

        // --- Auth Middlewares ---
        app.post('/jwt', async (req, res) => {
            const token = jwt.sign(req.body, process.env.JWT_SECRET, { expiresIn: '1h' });
            res.send({ token });
        });

        const verifyToken = (req, res, next) => {
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return res.status(401).send({ message: 'unauthorized access' });
            }
            const token = authHeader.split(' ')[1];
            jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
                if (err) return res.status(401).send({ message: 'unauthorized access' });
                req.decoded = decoded;
                next();
            });
        };

        const verifyAdmin = async (req, res, next) => {
            const user = await usersCollection.findOne({ email: req.decoded.email });
            if (user?.role !== 'Admin') return res.status(403).send({ message: 'forbidden access' });
            next();
        };

        // --- APIs ---
        app.post('/users', async (req, res) => {
            const existing = await usersCollection.findOne({ email: req.body.email });
            if (existing) return res.send({ message: 'exists' });
            res.send(await usersCollection.insertOne({ ...req.body, role: 'User', status: 'Free', createdAt: new Date() }));
        });

        app.get('/users/login-check/:email', async (req, res) => {
            res.send(await usersCollection.findOne({ email: req.params.email }));
        });

        app.get('/user-stats/:email', verifyToken, async (req, res) => {
            const count = await promptsCollection.countDocuments({ creatorEmail: req.params.email });
            const user = await usersCollection.findOne({ email: req.params.email });
            res.send({ promptCount: count, status: user?.status, role: user?.role });
        });

        app.post('/add-prompt', verifyToken, async (req, res) => {
            const user = await usersCollection.findOne({ email: req.decoded.email });
            const count = await promptsCollection.countDocuments({ creatorEmail: req.decoded.email });
            if (user.status === 'Free' && count >= 3) return res.status(403).send({ message: 'limit-reached' });
            res.send(await promptsCollection.insertOne({ ...req.body, creatorEmail: req.decoded.email, status: 'pending', createdAt: new Date() }));
        });

        app.get('/my-prompts/:email', verifyToken, async (req, res) => {
            res.send(await promptsCollection.find({ creatorEmail: req.params.email }).toArray());
        });

        app.get('/prompts', async (req, res) => {
            const { search, category, aiTool, sort } = req.query;
            let query = { status: 'approved' };
            if (search) query.title = { $regex: search, $options: 'i' };
            if (category) query.category = category;
            if (aiTool) query.aiTool = aiTool;
            const result = await promptsCollection.find(query).toArray();
            res.send({ result });
        });

        app.get('/prompts/:id', async (req, res) => {
            res.send(await promptsCollection.findOne({ _id: new ObjectId(req.params.id) }));
        });

        app.post('/simulate-payment', verifyToken, async (req, res) => {
            const email = req.decoded.email;
            await paymentsCollection.insertOne({ email, amount: 5, transactionId: `SIM_${Date.now()}`, date: new Date() });
            await usersCollection.updateOne({ email }, { $set: { status: 'Premium' } });
            res.send({ success: true });
        });

        app.get('/admin-stats', verifyToken, verifyAdmin, async (req, res) => {
            const stats = await promptsCollection.aggregate([{ $group: { _id: null, totalPrompts: { $sum: 1 }, totalCopies: { $sum: "$copyCount" }, avgRating: { $avg: "$rating" } } }]).toArray();
            const totalUsers = await usersCollection.countDocuments();
            res.send({ stats: stats[0] || {}, totalUsers });
        });

        console.log("Master Backend Synchronized ✅");
    } finally { }
}
run().catch(console.dir);
app.get('/', (req, res) => res.send('Neural Mainframe Active'));
app.listen(port, () => console.log(`Listening on ${port}`));