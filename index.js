require("dotenv").config();
const express = require("express");
const cors = require("cors");
const app = express();
const port = 3000;
const { MongoClient, ServerApiVersion } = require("mongodb");
const jwt = require("jsonwebtoken");
// const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);
const bcrypt = require("bcrypt");
const cookieParser = require("cookie-parser");

app.use(
  cors({
    origin: ["https://sams-kitchen.netlify.app", "http://localhost:5173"],
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

app.get("/", (req, res) => {
  res.send("Sam's Kitchen is cooking");
});

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.or0q8ig.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  const verifyJwt = (req, res, next) => {
    const token = req.cookies.token;

    if (!token) {
      return res.status(401).send({ message: "Unauthorized Access" });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
      if (err) {
        return res.status(403).send({ message: "Forbidden: Invalid token" });
      }

      if (req.query.email !== decoded.email) {
        return res.status(403).send({ message: "Forbidden: Email mismatch" });
      }
      req.user = decoded;

      next();
    });
  };

  const verifyAdmin = (req, res, next) => {
    if (req.user.role !== "admin") {
      return res.status(403).send({ message: "Forbidden: Admins only" });
    }
    next();
  };

  // const verifyCustomer = (req, res, next) => {
  //   if (req.user.role !== "customer") {
  //     return res.status(403).send({ message: "Forbidden: Customer only" });
  //   }
  //   next();
  // };

  // const verifyRider = (req, res, next) => {
  //   if (req.user.role !== "rider") {
  //     return res.status(403).send({ message: "Forbidden: Riders only" });
  //   }
  //   next();
  // };

  try {
    await client.connect();

    const db = client.db("Sams-Kitchen");
    const usersCollection = db.collection("usersCollection");
    const foodsCollection = db.collection("foodsCollection");

    // JWT API
    app.post("/jwt", async (req, res) => {
      const { email } = req.body;
      const user = await usersCollection.findOne({ email });

      const payload = { email: user.email, role: user.role };
      const token = jwt.sign(payload, process.env.JWT_SECRET, {
        expiresIn: "1d",
      });

      res.cookie("token", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
        maxAge: 24 * 60 * 60 * 1000,
      });

      res.send({ success: true, token });
    });

    // remove token when logout
    app.post("/logout", (req, res) => {
      res.clearCookie("token", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      });
      res.send({ success: true });
    });

    // users api
    app.get("/users", verifyJwt, verifyAdmin, async (req, res) => {
      try {
        let {
          page = 1,
          limit = 10,
          search = "",
          searchType = "name",
          role = "",
        } = req.query;

        page = parseInt(page);
        limit = parseInt(limit);

        const query = {};

        if (search) {
          const regex = new RegExp(search, "i");
          if (searchType === "email") {
            query.email = regex;
          } else {
            query.name = regex;
          }
        }

        if (role) {
          query.role = role;
        }

        const skip = (page - 1) * limit;
        const total = await usersCollection.countDocuments(query);
        const users = await usersCollection
          .find(query)
          .skip(skip)
          .limit(limit)
          .toArray();

        res.send({ users, total });
      } catch (err) {
        res.status(500).send({ message: "Server error", error: err.message });
      }
    });

    app.get("/users/:email/role", async (req, res) => {
      try {
        const email = req.params.email;

        if (!email) {
          return res.status(400).send({ message: "Email is required" });
        }

        const user = await usersCollection.findOne({ email });

        if (!user) {
          return res.status(404).send({ message: "User not found" });
        }

        res.send({ role: user.role });
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    app.post("/users", async (req, res) => {
      const user = req.body;
      const email = user.email;

      const userExists = await usersCollection.findOne({ email });

      if (userExists) {
        const updateResult = await usersCollection.updateOne(
          { email },
          { $set: { last_log_in: user.last_log_in } }
        );
        return res.status(200).send({
          message: "User already exists, last_log_in updated",
          updated: updateResult.modifiedCount > 0,
        });
      }

      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    app.patch("/users", async (req, res) => {
      try {
        const { name, photo } = req.body;
        const { email } = req.query;

        if (!email) {
          return res
            .status(400)
            .send({ success: false, message: "Email is required." });
        }

        const filter = { email };
        const updateDoc = {
          $set: {
            name,
            photo,
          },
        };

        const result = await usersCollection.updateOne(filter, updateDoc);
        res.send(result);
      } catch (_) {
        res.status(500).send({
          success: false,
          message: "Internal server error while updating profile",
        });
      }
    });

    // foods api
    app.post("/foods", verifyJwt, verifyAdmin, async (req, res) => {
      try {
        const {
          name,
          price,
          discount = 0,
          description = "",
          images,
          available = true,
          addedAt,
        } = req.body;

        const newFood = {
          name: name.trim(),
          price,
          discount,
          description: description.trim(),
          images,
          available,
          addedAt,
        };

        const result = await foodsCollection.insertOne(newFood);

        res.status(201).json({
          message: "Food added successfully",
          foodId: result.insertedId,
        });
      } catch (error) {
        res.status(500).json({ error: "Internal server error" });
      }
    });

    await client.db("admin").command({ ping: 1 });
    console.log("Connected to MongoDB!");
  } finally {
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Sam's Kitchen running on port ${port}`);
});
