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
    origin: ["http://localhost:5173"],
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

app.get("/", (req, res) => {
  res.send("Assignment 12 is cooking");
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
  // const verifyJwt = (req, res, next) => {
  //   const token = req.cookies.token;

  //   if (!token) {
  //     return res.status(401).send({ message: "Unauthorized Access" });
  //   }

  //   jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
  //     if (err) {
  //       return res.status(403).send({ message: "Forbidden: Invalid token" });
  //     }

  //     if (req.query.email !== decoded.email) {
  //       return res.status(403).send({ message: "Forbidden: Email mismatch" });
  //     }
  //     req.user = decoded;

  //     next();
  //   });
  // };

  try {
    await client.connect();

    const db = client.db("Sams-Kitchen");
    const usersCollection = db.collection("usersCollection");

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
        secure: false,
        sameSite: "lax",
        maxAge: 24 * 60 * 60 * 1000,
      });

      res.send({ success: true, token });
    });

    // remove token when logout
    app.post("/logout", (req, res) => {
      res.clearCookie("token", {
        httpOnly: true,
        secure: false,
        sameSite: "lax",
      });
      res.send({ success: true });
    });

    // users api
    app.post("/users", async (req, res) => {
      const user = req.body;
      const email = user.email;
      const password = user.password;
      if (password) {
        const hashedpassword = await bcrypt.hash(password, 10);
        user.password = hashedpassword;
      }

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

    await client.db("admin").command({ ping: 1 });
    console.log("Connected to MongoDB!");
  } finally {
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Assignment 12 running on port ${port}`);
});
