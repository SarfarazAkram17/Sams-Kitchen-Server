const express = require("express");
const router = express.Router();
const verifyJwt = require("../middleware/verifyJwt");
const verifyAdmin = require("../middleware/verifyAdmin");

module.exports = (usersCollection) => {
  router.get("/", verifyJwt, verifyAdmin, async (req, res) => {
    try {
      let { page = 1, limit = 10, search = "", searchType = "name", role = "" } = req.query;

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

  router.get("/:email/role", async (req, res) => {
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

  router.post("/", async (req, res) => {
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

  router.patch("/", verifyJwt, async (req, res) => {
    try {
      const { name, photo } = req.body;
      const { email } = req.query;

      if (!email) {
        return res.status(400).send({ success: false, message: "Email is required." });
      }

      const filter = { email };
      const updateDoc = { $set: { name, photo } };

      const result = await usersCollection.updateOne(filter, updateDoc);
      res.send(result);
    } catch (_) {
      res.status(500).send({
        success: false,
        message: "Internal server error while updating profile",
      });
    }
  });

  return router;
};