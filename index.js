const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

// ==========================================
// 1. CORS & Middlewares
// ==========================================
app.use(cors({
    origin: [
        'https://assainment10-client.vercel.app', 
        'http://localhost:3000'
    ],
    credentials: true
}));
app.options('*', cors());
app.use(express.json());

// --- MongoDB Connection ---
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ay91vcf.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
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

        // ==========================================
        // 2. JWT & Security
        // ==========================================
        app.post('/jwt', async (req, res) => {
            const token = jwt.sign(req.body, process.env.JWT_SECRET, { expiresIn: '1h' });
            res.send({ token });
        });

        const verifyToken = (req, res, next) => {
            if (!req.headers.authorization) return res.status(401).send({ message: 'unauthorized' });
            const token = req.headers.authorization.split(' ')[1];
            jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
                if (err) return res.status(401).send({ message: 'unauthorized' });
                req.decoded = decoded;
                next();
            });
        };

        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded.email;
            const user = await usersCollection.findOne({ email });
            if (user?.role !== 'Admin') return res.status(403).send({ message: 'forbidden' });
            next();
        };

        // ==========================================
        // 3. User & Role Management
        // ==========================================
        app.post('/users', async (req, res) => {
            const user = req.body;
            const existing = await usersCollection.findOne({ email: user.email });
            if (existing) return res.send({ message: 'Exists', insertedId: null });
            const result = await usersCollection.insertOne({ ...user, role: 'User', status: 'Free', createdAt: new Date() });
            res.send(result);
        });

        app.get('/users/login-check/:email', async (req, res) => {
            res.send(await usersCollection.findOne({ email: req.params.email }));
        });

        app.get('/users/me/:email', verifyToken, async (req, res) => {
            res.send(await usersCollection.findOne({ email: req.params.email }));
        });

        app.get('/admin/all-users', verifyToken, verifyAdmin, async (req, res) => {
            res.send(await usersCollection.find().toArray());
        });

        app.patch('/admin/users/role/:id', verifyToken, verifyAdmin, async (req, res) => {
            res.send(await usersCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { role: req.body.role } }));
        });

        // প্রোফাইল পেজের ডাইনামিক স্ট্যাটস
        app.get('/user-stats/:email', verifyToken, async (req, res) => {
            const count = await promptsCollection.countDocuments({ creatorEmail: req.params.email });
            const user = await usersCollection.findOne({ email: req.params.email });
            res.send({ promptCount: count, status: user?.status, role: user?.role });
        });

        // ==========================================
        // 4. Prompt Management (CRUD & Limits)
        // ==========================================
        app.post('/add-prompt', verifyToken, async (req, res) => {
            const user = await usersCollection.findOne({ email: req.decoded.email });
            const count = await promptsCollection.countDocuments({ creatorEmail: req.decoded.email });
            if (user.status === 'Free' && count >= 3) {
                return res.status(403).send({ message: 'limit-reached' });
            }
            res.send(await promptsCollection.insertOne({ ...req.body, status: 'pending', copyCount: 0, rating: 0, createdAt: new Date() }));
        });

        app.patch('/prompts/:id', verifyToken, async (req, res) => {
            res.send(await promptsCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: req.body }));
        });

        app.delete('/prompts/:id', verifyToken, async (req, res) => {
            res.send(await promptsCollection.deleteOne({ _id: new ObjectId(req.params.id) }));
        });

        app.get('/my-prompts/:email', verifyToken, async (req, res) => {
            res.send(await promptsCollection.find({ creatorEmail: req.params.email }).toArray());
        });

        app.patch('/prompts/copy-count/:id', async (req, res) => {
            res.send(await promptsCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $inc: { copyCount: 1 } }));
        });

        // ==========================================
        // 5. Admin Moderation & Analytics
        // ==========================================
        app.get('/admin/all-prompts', verifyToken, verifyAdmin, async (req, res) => {
            res.send(await promptsCollection.find().toArray());
        });

        app.patch('/admin/prompt-status/:id', verifyToken, verifyAdmin, async (req, res) => {
            res.send(await promptsCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status: req.body.status, feedback: req.body.feedback || "" } }));
        });

        app.get('/admin-stats', verifyToken, verifyAdmin, async (req, res) => {
            const stats = await promptsCollection.aggregate([
                { $group: { _id: null, totalPrompts: { $sum: 1 }, totalCopies: { $sum: "$copyCount" }, avgRating: { $avg: "$rating" } } }
            ]).toArray();
            const totalUsers = await usersCollection.countDocuments();
            const totalRevenue = await paymentsCollection.aggregate([{ $group: { _id: null, total: { $sum: "$amount" } } }]).toArray();
            res.send({ stats: stats[0] || {}, totalUsers, totalRevenue: totalRevenue[0]?.total || 0 });
        });

        app.get('/admin/all-payments', verifyToken, verifyAdmin, async (req, res) => {
            res.send(await paymentsCollection.find().sort({ date: -1 }).toArray());
        });

        // ==========================================
        // 6. Interaction APIs (Reviews, Bookmarks, Reports)
        // ==========================================
        app.post('/reviews', verifyToken, async (req, res) => {
            res.send(await reviewsCollection.insertOne({ ...req.body, date: new Date() }));
        });

        app.get('/reviews/prompt/:id', async (req, res) => {
            res.send(await reviewsCollection.find({ promptId: req.params.id }).toArray());
        });

        app.get('/my-reviews/:email', verifyToken, async (req, res) => {
            res.send(await reviewsCollection.find({ reviewerEmail: req.params.email }).toArray());
        });

        // Bookmark Toggle (Add if not exists, Remove if exists)
        app.post('/bookmarks', verifyToken, async (req, res) => {
            const query = { userEmail: req.body.userEmail, promptId: req.body.promptId };
            const exists = await bookmarksCollection.findOne(query);
            if (exists) {
                await bookmarksCollection.deleteOne(query);
                return res.send({ message: "removed" });
            } else {
                await bookmarksCollection.insertOne({ ...req.body, date: new Date() });
                return res.send({ message: "saved" });
            }
        });

        app.get('/bookmarks/:email', verifyToken, async (req, res) => {
            res.send(await bookmarksCollection.find({ userEmail: req.params.email }).toArray());
        });

        app.post('/reports', verifyToken, async (req, res) => {
            res.send(await reportsCollection.insertOne({ ...req.body, date: new Date() }));
        });

        app.get('/admin/reports', verifyToken, verifyAdmin, async (req, res) => {
            res.send(await reportsCollection.find().toArray());
        });

        app.delete('/admin/reports/:id', verifyToken, verifyAdmin, async (req, res) => {
            res.send(await reportsCollection.deleteOne({ _id: new ObjectId(req.params.id) }));
        });

        app.delete('/admin/remove-prompt/:id', verifyToken, verifyAdmin, async (req, res) => {
            const promptId = req.params.id;
            await promptsCollection.deleteOne({ _id: new ObjectId(promptId) });
            await reportsCollection.deleteMany({ promptId: promptId });
            res.send({ message: "deleted" });
        });

        // ==========================================
        // 7. Creator Dashboard Data
        // ==========================================
        app.get('/creator-stats/:email', verifyToken, async (req, res) => {
            const email = req.params.email;
            const stats = await promptsCollection.aggregate([
                { $match: { creatorEmail: email } },
                { $group: { _id: null, totalPrompts: { $sum: 1 }, totalCopies: { $sum: "$copyCount" }, totalBookmarks: { $sum: { $ifNull: ["$bookmarkCount", 0] } } } }
            ]).toArray();
            const chartData = await promptsCollection.find({ creatorEmail: email }).project({ title: 1, copyCount: 1, bookmarkCount: 1 }).toArray();
            res.send({ stats: stats[0] || { totalPrompts: 0, totalCopies: 0, totalBookmarks: 0 }, chartData });
        });

        // ==========================================
        // 8. Marketplace & Home Page
        // ==========================================
        app.get('/featured-prompts', async (req, res) => {
            res.send(await promptsCollection.find({ status: 'approved' }).limit(6).sort({ createdAt: -1 }).toArray());
        });

        app.get('/prompts', async (req, res) => {
            const { search, category, aiTool, sort, page = 1, limit = 6 } = req.query;
            const skip = (parseInt(page) - 1) * parseInt(limit);
            let query = { status: 'approved' };
            if (search) query.title = { $regex: search, $options: 'i' };
            if (category) query.category = category;
            if (aiTool) query.aiTool = aiTool;
            let sortObj = { createdAt: -1 };
            if (sort === 'popular') sortObj = { rating: -1 };
            if (sort === 'copies') sortObj = { copyCount: -1 };

            const result = await promptsCollection.find(query).sort(sortObj).skip(skip).limit(parseInt(limit)).toArray();
            const total = await promptsCollection.countDocuments(query);
            res.send({ result, total });
        });

        app.get('/prompts/:id', async (req, res) => {
            res.send(await promptsCollection.findOne({ _id: new ObjectId(req.params.id) }));
        });

        // ==========================================
        // 9. Payment APIs
        // ==========================================
        app.post('/simulate-payment', verifyToken, async (req, res) => {
            const email = req.decoded.email;
            await paymentsCollection.insertOne({ email, amount: 5.00, transactionId: `SIM_${Date.now()}`, date: new Date(), method: 'Simulation' });
            await usersCollection.updateOne({ email }, { $set: { status: 'Premium' } });
            res.send({ success: true });
        });

        app.post('/create-payment-intent', verifyToken, async (req, res) => {
            const paymentIntent = await stripe.paymentIntents.create({ amount: 500, currency: 'usd', payment_method_types: ['card'] });
            res.send({ clientSecret: paymentIntent.client_secret });
        });

        app.post('/payments', verifyToken, async (req, res) => {
            const payment = req.body;
            await paymentsCollection.insertOne(payment);
            res.send(await usersCollection.updateOne({ email: payment.email }, { $set: { status: 'Premium' } }));
        });

        console.log("Neural System 100% Synced! API Ready ✅");
    } finally { }
}
run().catch(console.dir);
app.get('/', (req, res) => res.send('PROMPTLY Server Active'));
app.listen(port, () => console.log(`Listening on port ${port}`));