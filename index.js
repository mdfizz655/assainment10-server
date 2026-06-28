const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

// ১. সুপার শক্তিশালী CORS (যাতে ব্রাউজার আর বিরক্ত না করে)
app.use(cors({ origin: true, credentials: true }));
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', req.header('Origin') || '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ay91vcf.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const client = new MongoClient(uri, { serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true } });

async function run() {
    try {
        const db = client.db("promptlyDB");
        const usersCollection = db.collection("users");
        const promptsCollection = db.collection("prompts");
        const paymentsCollection = db.collection("payments");

        // ২. টোকেন চেক (সরাসরি কোডেই একটা সিক্রেট দেওয়া হয়েছে যদি ড্যাশবোর্ডে ভুল হয়)
        const secret = process.env.JWT_SECRET || "6f9b8c3d2a1e5f7b4c0d9e8a7f6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b";

        const verifyToken = (req, res, next) => {
            const authHeader = req.headers.authorization;
            if (!authHeader) return res.status(401).send({ message: 'No Token' });
            const token = authHeader.split(' ')[1];
            jwt.verify(token, secret, (err, decoded) => {
                if (err) return res.status(401).send({ message: 'Invalid Token' });
                req.decoded = decoded;
                next();
            });
        };

        app.post('/jwt', async (req, res) => {
            const token = jwt.sign(req.body, secret, { expiresIn: '1h' });
            res.send({ token });
        });

        // ৩. প্রম্পট অ্যাড লজিক
        app.post('/add-prompt', verifyToken, async (req, res) => {
            const email = req.decoded.email;
            const user = await usersCollection.findOne({ email });
            const count = await promptsCollection.countDocuments({ creatorEmail: email });
            if (user?.status === 'Free' && count >= 3) return res.status(403).send({ message: 'limit-reached' });
            res.send(await promptsCollection.insertOne({ ...req.body, creatorEmail: email, status: 'pending', createdAt: new Date() }));
        });

        // ৪. পেমেন্ট সিমুলেশন (এডমিন প্যানেলে শো করার জন্য লজিক ফিক্সড)
        app.post('/simulate-payment', verifyToken, async (req, res) => {
            const email = req.decoded.email;
            const user = await usersCollection.findOne({ email });
            const mockPayment = { 
                email, 
                userName: user?.name || "Member",
                amount: 5.00, 
                transactionId: `SIM_${Date.now()}`, 
                date: new Date(), 
                method: 'Simulation' 
            };
            await paymentsCollection.insertOne(mockPayment);
            await usersCollection.updateOne({ email: email }, { $set: { status: 'Premium' } });
            res.send({ success: true });
        });

        // ৫. এডমিন পেমেন্ট লিস্ট
        app.get('/admin/all-payments', verifyToken, async (req, res) => {
            res.send(await paymentsCollection.find().sort({ date: -1 }).toArray());
        });

        // ৬. ইউজার লগইন চেক
        app.get('/users/login-check/:email', async (req, res) => {
            res.send(await usersCollection.findOne({ email: req.params.email }));
        });

        app.post('/users', async (req, res) => {
            const existing = await usersCollection.findOne({ email: req.body.email });
            if (existing) return res.send({ message: 'exists' });
            res.send(await usersCollection.insertOne({ ...req.body, role: 'User', status: 'Free', createdAt: new Date() }));
        });

        console.log("Master Mainframe Synchronized ✅");
    } finally { }
}
run().catch(console.dir);
app.get('/', (req, res) => res.send('API LIVE'));
app.listen(port, () => console.log(`Port ${port}`));