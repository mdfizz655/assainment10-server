const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

// ==========================================
// 1. CORS Configuration (সবার উপরে থাকবে)
// ==========================================
const corsOptions = {
    origin: [
        'https://assainment10-client.vercel.app',
        'http://localhost:3000'
    ],
    credentials: true,
    optionSuccessStatus: 200,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
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
        // 2. JWT & Auth Middlewares
        // ==========================================
        app.post('/jwt', async (req, res) => {
            const user = req.body;
            const token = jwt.sign(user, process.env.JWT_SECRET, { expiresIn: '1h' });
            res.send({ token });
        });

        const verifyToken = (req, res, next) => {
            const authHeader = req.headers.authorization;
            if (!authHeader) {
                return res.status(401).send({ message: 'unauthorized access' });
            }
            const token = authHeader.split(' ')[1];
            jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
                if (err) {
                    return res.status(401).send({ message: 'unauthorized access' });
                }
                req.decoded = decoded;
                next();
            });
        };

        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded.email;
            const user = await usersCollection.findOne({ email });
            if (user?.role !== 'Admin') {
                return res.status(403).send({ message: 'forbidden access' });
            }
            next();
        };

        // ==========================================
        // 3. User & Stats APIs
        // ==========================================
        app.post('/users', async (req, res) => {
            const user = req.body;
            const existing = await usersCollection.findOne({ email: user.email });
            if (existing) return res.send({ message: 'exists', insertedId: null });
            const result = await usersCollection.insertOne({ ...user, role: 'User', status: 'Free', createdAt: new Date() });
            res.send(result);
        });

        app.get('/users/login-check/:email', async (req, res) => {
            res.send(await usersCollection.findOne({ email: req.params.email }));
        });

        app.get('/user-stats/:email', verifyToken, async (req, res) => {
            // FIX: Email ownership check — নিজের stats শুধু নিজে দেখতে পারবে
            if (req.decoded.email !== req.params.email) {
                return res.status(403).send({ message: 'forbidden access' });
            }
            const count = await promptsCollection.countDocuments({ creatorEmail: req.params.email });
            const user = await usersCollection.findOne({ email: req.params.email });
            res.send({ promptCount: count, status: user?.status, role: user?.role });
        });

        app.get('/admin/all-users', verifyToken, verifyAdmin, async (req, res) => {
            const result = await usersCollection.find().toArray();
            res.send(result);
        });

        app.patch('/admin/users/role/:id', verifyToken, verifyAdmin, async (req, res) => {
            res.send(await usersCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { role: req.body.role } }));
        });

        // ==========================================
        // 4. Prompt Management (CRUD & Logic)
        // ==========================================
        app.post('/add-prompt', verifyToken, async (req, res) => {
            const email = req.decoded.email;
            const user = await usersCollection.findOne({ email });
            const count = await promptsCollection.countDocuments({ creatorEmail: email });

            if (user.status === 'Free' && count >= 3) {
                return res.status(403).send({ message: 'limit-reached' });
            }

            const newPrompt = {
                ...req.body,
                creatorEmail: email,
                status: 'pending',
                copyCount: 0,
                bookmarkCount: 0,
                rating: 0,
                createdAt: new Date()
            };
            res.send(await promptsCollection.insertOne(newPrompt));
        });

        app.patch('/prompts/:id', verifyToken, async (req, res) => {
            res.send(await promptsCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: req.body }));
        });

        app.delete('/prompts/:id', verifyToken, async (req, res) => {
            res.send(await promptsCollection.deleteOne({ _id: new ObjectId(req.params.id) }));
        });

        app.get('/my-prompts/:email', verifyToken, async (req, res) => {
            // FIX: Email ownership check — অন্য user-এর prompts দেখা যাবে না
            if (req.decoded.email !== req.params.email) {
                return res.status(403).send({ message: 'forbidden access' });
            }
            res.send(await promptsCollection.find({ creatorEmail: req.params.email }).toArray());
        });

        // FIX: verifyToken যোগ করা হয়েছে — আগে কোনো auth ছিল না
        app.patch('/prompts/copy-count/:id', verifyToken, async (req, res) => {
            res.send(await promptsCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $inc: { copyCount: 1 } }));
        });

        // ==========================================
        // 5. Interactions (Reviews, Bookmarks, Reports)
        // ==========================================
        app.post('/reviews', verifyToken, async (req, res) => {
            res.send(await reviewsCollection.insertOne({ ...req.body, date: new Date() }));
        });

        app.get('/reviews/prompt/:id', async (req, res) => {
            res.send(await reviewsCollection.find({ promptId: req.params.id }).toArray());
        });

        app.get('/my-reviews/:email', verifyToken, async (req, res) => {
            // FIX: Email ownership check — অন্য user-এর reviews দেখা যাবে না
            if (req.decoded.email !== req.params.email) {
                return res.status(403).send({ message: 'forbidden access' });
            }
            res.send(await reviewsCollection.find({ reviewerEmail: req.params.email }).toArray());
        });

        app.post('/bookmarks', verifyToken, async (req, res) => {
            const { userEmail, promptId } = req.body;

            // FIX: Email ownership check
            if (req.decoded.email !== userEmail) {
                return res.status(403).send({ message: 'forbidden access' });
            }

            const exists = await bookmarksCollection.findOne({ userEmail, promptId });
            if (exists) {
                await bookmarksCollection.deleteOne({ userEmail, promptId });
                // FIX: bookmarkCount আপডেট করা হচ্ছে — আগে হতো না
                await promptsCollection.updateOne(
                    { _id: new ObjectId(promptId) },
                    { $inc: { bookmarkCount: -1 } }
                );
                return res.send({ message: "removed" });
            } else {
                await bookmarksCollection.insertOne({ ...req.body, date: new Date() });
                // FIX: bookmarkCount আপডেট করা হচ্ছে — আগে হতো না
                await promptsCollection.updateOne(
                    { _id: new ObjectId(promptId) },
                    { $inc: { bookmarkCount: 1 } }
                );
                return res.send({ message: "saved" });
            }
        });

        app.get('/bookmarks/:email', verifyToken, async (req, res) => {
            // FIX: Email ownership check
            if (req.decoded.email !== req.params.email) {
                return res.status(403).send({ message: 'forbidden access' });
            }
            res.send(await bookmarksCollection.find({ userEmail: req.params.email }).toArray());
        });

        app.post('/reports', verifyToken, async (req, res) => {
            res.send(await reportsCollection.insertOne({ ...req.body, date: new Date() }));
        });

        // ==========================================
        // 6. Marketplace & Analytics
        // ==========================================
        app.get('/featured-prompts', async (req, res) => {
            // FIX: sort() আগে, limit() পরে — আগে উল্টো ছিল
            res.send(await promptsCollection.find({ status: 'approved' }).sort({ createdAt: -1 }).limit(6).toArray());
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
        // 7. Creator & Admin Dashboards (Aggregation)
        // ==========================================
        app.get('/creator-stats/:email', verifyToken, async (req, res) => {
            // FIX: Email ownership check
            if (req.decoded.email !== req.params.email) {
                return res.status(403).send({ message: 'forbidden access' });
            }
            const stats = await promptsCollection.aggregate([
                { $match: { creatorEmail: req.params.email } },
                { $group: { _id: null, totalPrompts: { $sum: 1 }, totalCopies: { $sum: "$copyCount" }, totalBookmarks: { $sum: { $ifNull: ["$bookmarkCount", 0] } } } }
            ]).toArray();
            const chartData = await promptsCollection.find({ creatorEmail: req.params.email }).project({ title: 1, copyCount: 1, bookmarkCount: 1 }).toArray();
            res.send({ stats: stats[0] || { totalPrompts: 0, totalCopies: 0, totalBookmarks: 0 }, chartData });
        });

        app.get('/admin-stats', verifyToken, verifyAdmin, async (req, res) => {
            const stats = await promptsCollection.aggregate([{ $group: { _id: null, totalPrompts: { $sum: 1 }, totalCopies: { $sum: "$copyCount" }, avgRating: { $avg: "$rating" } } }]).toArray();
            const totalUsers = await usersCollection.countDocuments();
            const totalRevenue = await paymentsCollection.aggregate([{ $group: { _id: null, total: { $sum: "$amount" } } }]).toArray();
            res.send({ stats: stats[0] || {}, totalUsers, totalRevenue: totalRevenue[0]?.total || 0 });
        });

        // ==========================================
        // 8. Payment APIs (Stripe & Simulation)
        // ==========================================
        app.post('/simulate-payment', verifyToken, async (req, res) => {
            const email = req.decoded.email;
            const user = await usersCollection.findOne({ email });
            const mockPayment = { email, userName: user?.name, amount: 5.00, transactionId: `SIM_${Date.now()}`, date: new Date(), method: 'Sandbox' };
            await paymentsCollection.insertOne(mockPayment);
            await usersCollection.updateOne({ email }, { $set: { status: 'Premium' } });
            res.send({ success: true });
        });

        // FIX: try/catch যোগ করা হয়েছে — Stripe error হলে server crash হবে না
        app.post('/create-payment-intent', verifyToken, async (req, res) => {
            try {
                const paymentIntent = await stripe.paymentIntents.create({
                    amount: 500,
                    currency: 'usd',
                    payment_method_types: ['card']
                });
                res.send({ clientSecret: paymentIntent.client_secret });
            } catch (err) {
                console.error('Stripe error:', err);
                res.status(500).send({ message: 'Payment intent creation failed', error: err.message });
            }
        });

        app.post('/payments', verifyToken, async (req, res) => {
            await paymentsCollection.insertOne(req.body);
            await usersCollection.updateOne({ email: req.body.email }, { $set: { status: 'Premium' } });
            res.send({ success: true });
        });

        app.get('/admin/all-payments', verifyToken, verifyAdmin, async (req, res) => {
            res.send(await paymentsCollection.find().sort({ date: -1 }).toArray());
        });

        // ==========================================
        // 9. Admin Moderation Tools
        // ==========================================
        app.get('/admin/all-prompts', verifyToken, verifyAdmin, async (req, res) => {
            res.send(await promptsCollection.find().toArray());
        });

        // FIX: usersCollection → promptsCollection — এটাই সবচেয়ে বড় বাগ ছিল
        app.patch('/admin/prompt-status/:id', verifyToken, verifyAdmin, async (req, res) => {
            res.send(await promptsCollection.updateOne(
                { _id: new ObjectId(req.params.id) },
                { $set: { status: req.body.status, feedback: req.body.feedback || "" } }
            ));
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

        console.log("Neural System Synchronized! API 100% Ready ✅");
    } finally {
        // FIX: Connection এখন properly close হবে
        // await client.close();
        // Note: Production server-এ এই line comment করা থাকবে,
        // কারণ server সবসময় চলমান থাকে।
        // শুধু script/one-time task-এ uncomment করুন।
    }
}

run().catch(console.dir);

app.get('/', (req, res) => res.send('Neural Mainframe Online'));
app.listen(port, () => console.log(`Listening on ${port}`));