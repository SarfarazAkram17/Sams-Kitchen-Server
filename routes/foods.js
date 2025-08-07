const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const verifyJwt = require("../middleware/verifyJwt");
const verifyAdmin = require("../middleware/verifyAdmin");

module.exports = (foodsCollection, notificationsCollection) => {
  router.get("/", async (req, res) => {
    try {
      let { page = 1, limit = 10 } = req.query;
      page = parseInt(page);
      limit = parseInt(limit);
      const skip = (page - 1) * limit;

      const total = await foodsCollection.countDocuments();
      const foods = await foodsCollection
        .find({})
        .sort({ addedAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray();

      res.send({ foods, total });
    } catch (err) {
      res
        .status(500)
        .send({ message: "Failed to fetch foods", error: err.message });
    }
  });

  router.get("/search", async (req, res) => {
    try {
      const { name } = req.query;

      if (!name) {
        return res.status(400).send({ message: "Search query is required" });
      }

      const searchRegex = new RegExp(name, "i");

      const foods = await foodsCollection
        .find({ name: { $regex: searchRegex } })
        .toArray();

      if (foods.length === 0) {
        return res
          .status(404)
          .send({ message: "No foods found with this name" });
      }

      res.send(foods);
    } catch (err) {
      res
        .status(500)
        .send({ message: "Failed to search foods", error: err.message });
    }
  });

  router.get("/:id", async (req, res) => {
    try {
      const id = req.params.id;
      const food = await foodsCollection.findOne({ _id: new ObjectId(id) });

      if (!food) {
        return res.status(404).send({ message: "Food not found" });
      }

      res.send(food);
    } catch (err) {
      res
        .status(500)
        .send({ message: "Failed to fetch food", error: err.message });
    }
  });

  router.post("/", verifyJwt, verifyAdmin, async (req, res) => {
    try {
      const {
        name,
        price,
        discount = 0,
        description = "",
        image,
        available = true,
        addedAt,
      } = req.body;

      const newFood = {
        name: name.trim(),
        price,
        discount,
        description: description.trim(),
        image,
        available,
        addedAt,
      };

      const result = await foodsCollection.insertOne(newFood);
      const foodId = result.insertedId;

      // Create broadcast notification for all users
      const notification = {
        type: "broadcast",
        message: `New food item: ${newFood.name}.`,
        relatedId: foodId.toString(),
        createdAt: new Date().toISOString(),
        readBy: [],
      };

      await notificationsCollection.insertOne(notification);

      res.status(201).json({
        message: "Food added successfully",
        foodId: result.insertedId,
      });
    } catch (_) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/cart", async (req, res) => {
    try {
      const { ids } = req.body;
      const foodIds = ids.map((id) => new ObjectId(id));

      const foods = await foodsCollection
        .find({ _id: { $in: foodIds } })
        .toArray();

      res.send(foods);
    } catch (err) {
      res
        .status(500)
        .send({ message: "Failed to fetch foods", error: err.message });
    }
  });

  router.patch("/:id", verifyJwt, verifyAdmin, async (req, res) => {
    try {
      const foodId = req.params.id;
      const { name, price, discount, description, available, image } = req.body;

      const query = { _id: new ObjectId(foodId) };
      const food = await foodsCollection.findOne(query);

      if (!food) {
        return res.status(404).json({ error: "Food not found" });
      }

      const updateDoc = {
        $set: {
          name,
          price,
          discount,
          description,
          available,
          image,
          updatedAt: new Date().toISOString(),
        },
      };

      const result = await foodsCollection.updateOne(query, updateDoc);

      if (discount > food.discount) {
        const notification = {
          type: "broadcast",
          message: `Discount added on food item: ${food.name}.`,
          relatedId: foodId.toString(),
          createdAt: new Date().toISOString(),
          readBy: [],
        };

        await notificationsCollection.insertOne(notification);
      }

      res.send(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.delete("/:id", verifyJwt, verifyAdmin, async (req, res) => {
    try {
      const id = req.params.id;
      const result = await foodsCollection.deleteOne({ _id: new ObjectId(id) });

      res.send(result);
    } catch (err) {
      res
        .status(500)
        .send({ message: "Failed to delete food", error: err.message });
    }
  });

  return router;
};
