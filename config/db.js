const { MongoClient, ServerApiVersion } = require("mongodb");
require("dotenv").config();

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.or0q8ig.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function connectDB() {
  try {
    await client.connect();
    const db = client.db("Sams-Kitchen");
    console.log("Connected to MongoDB!");
    return {
      usersCollection: db.collection("usersCollection"),
      foodsCollection: db.collection("foodsCollection"),
      ordersCollection: db.collection("ordersCollection"),
      paymentsCollection: db.collection("paymentsCollection"),
      ridersCollection: db.collection("ridersCollection"),
      reviewsCollection: db.collection("reviewsCollection"),
      notificationsCollection: db.collection("notificationsCollection"),
    };
  } catch (error) {
    console.error("Failed to connect to MongoDB:", error);
    throw error;
  }
}

module.exports = { connectDB, client };