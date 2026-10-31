import { MongoClient, ServerApiVersion } from "mongodb";
import "dotenv/config";

const DB_NAME = "Sams-Kitchen";

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

    const db = client.db(DB_NAME);
    console.log("Connected to MongoDB!");
    const deliveryOtpChallengesCollection = db.collection(
      "deliveryOtpChallenges",
    );
    await deliveryOtpChallengesCollection.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0 },
    );

    return {
      usersCollection: db.collection("usersCollection"),
      foodsCollection: db.collection("foodsCollection"),
      ordersCollection: db.collection("ordersCollection"),
      paymentsCollection: db.collection("paymentsCollection"),
      ridersCollection: db.collection("ridersCollection"),
      reviewsCollection: db.collection("reviewsCollection"),
      notificationsCollection: db.collection("notificationsCollection"),
      cashoutsCollection: db.collection("cashoutsCollection"),
      deliveryOtpChallengesCollection,
    };
  } catch (error) {
    console.error("Failed to connect to MongoDB:", error);
    throw error;
  }
}

export { connectDB, client, DB_NAME };