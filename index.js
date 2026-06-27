const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

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

        // 1. JWT & Security
        app.post('/jwt', async (req, res) => {
            const user = req.body;
            const token = jwt.sign(user, process.env.JWT_SECRET, { expiresIn: '1h' });
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
            const user = await usersCollection.findOne({ email: req.decoded.email });
            if (user?.role !== 'Admin') return res.status(403).send({ message: 'forbidden' });
            next();
        };

        // 2. Creator Stats API (আপনার ৪MD সমাধান)
        app.get('/creator-stats/:email', verifyToken, async (req, res) => {
            const email = req.params.email;
            
            // এগ্রিগেশন ব্যবহার করে স্ট্যাটাস বের করা
            const stats = await promptsCollection.aggregate([
                { $match: { creatorEmail: email } },
                {
                    $group: {
                        _id: null,
                        totalPrompts: { $sum: 1 },
                        totalCopies: { $sum: "$copyCount" },
                        totalBookmarks: { $sum: { $ifNull: ["$bookmarkCount", 0] } }
                    }
                }
            ]).toArray();

            // চার্টের জন্য ডাটা
            const chartData = await promptsCollection.find({ creatorEmail: email })
                .project({ title: 1, copyCount: 1, bookmarkCount: 1 })
                .toArray();

            res.send({ 
                stats: stats[0] || { totalPrompts: 0, totalCopies: 0, totalBookmarks: 0 }, 
                chartData 
            });
        });

        // 3. User & Roles
        app.post('/users', async (req, res) => {
            const user = req.body;
            const existing = await usersCollection.findOne({ email: user.email });
            if (existing) return res.send({ message: 'exists', insertedId: null });
            res.send(await usersCollection.insertOne({ ...user, role: 'User', status: 'Free', createdAt: new Date() }));
        });

        app.get('/users/login-check/:email', async (req, res) => {
            res.send(await usersCollection.findOne({ email: req.params.email }));
        });

        app.patch('/admin/users/role/:id', verifyToken, verifyAdmin, async (req, res) => {
            res.send(await usersCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { role: req.body.role } }));
        });

        app.get('/admin/all-users', verifyToken, verifyAdmin, async (req, res) => {
            res.send(await usersCollection.find().toArray());
        });

        // 4. Marketplace & Prompts
        app.get('/prompts', async (req, res) => {
            const { search, category, aiTool, sort, page = 1, limit = 6 } = req.query;
            const skip = (parseInt(page) - 1) * parseInt(limit);
            let query = { status: 'approved' };
            if (search) query.title = { $regex: search, $options: 'i' };
            if (category) query.category = category;
            if (aiTool) query.aiTool = aiTool;
            let sortOptions = { createdAt: -1 };
            if (sort === 'popular') sortOptions = { rating: -1 };
            const result = await promptsCollection.find(query).sort(sortOptions).skip(skip).limit(parseInt(limit)).toArray();
            const total = await promptsCollection.countDocuments(query);
            res.send({ result, total });
        });

        app.get('/prompts/:id', async (req, res) => {
            res.send(await promptsCollection.findOne({ _id: new ObjectId(req.params.id) }));
        });

        app.post('/add-prompt', verifyToken, async (req, res) => {
            const user = await usersCollection.findOne({ email: req.decoded.email });
            const count = await promptsCollection.countDocuments({ creatorEmail: req.decoded.email });
            if (user.status === 'Free' && count >= 3) return res.status(403).send({ message: 'Limit reached' });
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

        // 5. Reviews, Bookmarks & Reports
        app.post('/reviews', verifyToken, async (req, res) => {
            res.send(await reviewsCollection.insertOne({ ...req.body, date: new Date() }));
        });

        app.get('/reviews/prompt/:id', async (req, res) => {
            res.send(await reviewsCollection.find({ promptId: req.params.id }).toArray());
        });

        app.get('/my-reviews/:email', verifyToken, async (req, res) => {
            res.send(await reviewsCollection.find({ reviewerEmail: req.params.email }).toArray());
        });

        app.post('/bookmarks', verifyToken, async (req, res) => {
            const query = { userEmail: req.body.userEmail, promptId: req.body.promptId };
            const exists = await bookmarksCollection.findOne(query);
            if (exists) {
                await bookmarksCollection.deleteOne(query);
                res.send({ message: "removed" });
            } else {
                await bookmarksCollection.insertOne({ ...req.body, date: new Date() });
                res.send({ message: "saved" });
            }
        });

        app.get('/bookmarks/:email', verifyToken, async (req, res) => {
            res.send(await bookmarksCollection.find({ userEmail: req.params.email }).toArray());
        });

        app.post('/reports', verifyToken, async (req, res) => {
            res.send(await reportsCollection.insertOne({ ...req.body, date: new Date() }));
        });

        // 6. Admin Actions
        app.get('/admin/all-prompts', verifyToken, verifyAdmin, async (req, res) => {
            res.send(await promptsCollection.find().toArray());
        });

        app.patch('/admin/prompt-status/:id', verifyToken, verifyAdmin, async (req, res) => {
            res.send(await promptsCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status: req.body.status, feedback: req.body.feedback || "" } }));
        });

        app.get('/admin/reports', verifyToken, verifyAdmin, async (req, res) => {
            res.send(await reportsCollection.find().toArray());
        });

        app.get('/admin-stats', verifyToken, verifyAdmin, async (req, res) => {
            const stats = await promptsCollection.aggregate([{ $group: { _id: null, totalPrompts: { $sum: 1 }, totalCopies: { $sum: "$copyCount" }, avgRating: { $avg: "$rating" } } }]).toArray();
            const totalUsers = await usersCollection.countDocuments();
            res.send({ stats: stats[0] || {}, totalUsers });
        });

        app.get('/admin/all-payments', verifyToken, verifyAdmin, async (req, res) => {
            res.send(await paymentsCollection.find().sort({ date: -1 }).toArray());
        });

        // 7. Payments
        app.post('/simulate-payment', verifyToken, async (req, res) => {
            await paymentsCollection.insertOne({ email: req.decoded.email, amount: 5, date: new Date(), transactionId: `sim_${Date.now()}` });
            res.send(await usersCollection.updateOne({ email: req.decoded.email }, { $set: { status: 'Premium' } }));
        });

        console.log("Neural Database is Synced and API Ready!");
    } finally { }
}
run().catch(console.dir);
app.get('/', (req, res) => res.send('API Running'));
app.listen(port, () => console.log(`Neural Port ${port}`));