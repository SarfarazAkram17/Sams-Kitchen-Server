const express = require("express");
const router = express.Router();
const verifyJwt = require("../middleware/verifyJwt");

module.exports = (reviewsCollection) => {
  router.get("/", async (req, res) => {
    try {
      const { foodId, page = 1, limit = 3 } = req.query;

      if (!foodId) {
        return res.status(400).json({ error: "Food Id is required" });
      }

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const limitNum = parseInt(limit);

      const reviews = await reviewsCollection
        .find({ foodId })
        .sort({ postedAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .toArray();

      const total = await reviewsCollection.countDocuments({ foodId });

      res.json({ reviews, total });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  router.post("/", verifyJwt, async (req, res) => {
    try {
      const { foodId, userPhoto, userName, rating, comment, images, postedAt } = req.body;

      if (!foodId || !rating || !comment) {
        return res.status(400).json({ error: "foodId, rating and comment are required." });
      }

      const review = {
        foodId,
        userPhoto,
        userName,
        rating: Number(rating),
        comment,
        images,
        postedAt,
      };

      const result = await reviewsCollection.insertOne(review);

      res.status(201).json({
        success: true,
        reviewId: result.insertedId,
        message: "Review added successfully",
      });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  return router;
};