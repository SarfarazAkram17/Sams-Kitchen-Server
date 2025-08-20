const express = require("express");
const router = express.Router();
const verifyJwt = require("../middleware/verifyJwt");
const { ObjectId } = require("mongodb");

module.exports = (
  reviewsCollection,
  foodsCollection,
  notificationsCollection
) => {
  router.get("/", async (req, res) => {
    try {
      const { foodId, page = 1, limit = 3 } = req.query;

      if (!foodId) {
        return res.status(400).json({ error: "Food Id is required" });
      }

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const limitNum = parseInt(limit);

      // Get paginated reviews
      const reviews = await reviewsCollection
        .find({ foodId })
        .sort({ postedAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .toArray();

      // Get total reviews count
      const total = await reviewsCollection.countDocuments({ foodId });

      // Calculate average rating using aggregation
      const aggResult = await reviewsCollection
        .aggregate([
          { $match: { foodId } },
          { $group: { _id: null, avgRating: { $avg: "$rating" } } },
        ])
        .toArray();

      const avgRating = aggResult.length > 0 ? aggResult[0].avgRating : 0;

      res.json({ reviews, total, avgRating });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  router.post("/", verifyJwt, async (req, res) => {
    try {
      const { foodId, userPhoto, userName, rating, comment, images, postedAt } =
        req.body;

      if (!foodId || !rating || !comment) {
        return res
          .status(400)
          .json({ error: "foodId, rating and comment are required." });
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

      const food = await foodsCollection.findOne({ _id: new ObjectId(foodId) });

      const result = await reviewsCollection.insertOne(review);

      const notificationForUser = {
        type: "direct",
        email: req.query.email,
        message: `You added a review to: ${food.name}.`,
        relatedId: foodId.toString(),
        createdAt: new Date().toISOString(),
        isRead: false,
      };

      await notificationsCollection.insertOne(notificationForUser);

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
