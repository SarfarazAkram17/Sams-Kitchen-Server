import express from "express";
const router = express.Router();
import { ObjectId } from "mongodb";
import verifyJwt from "../middleware/verifyJwt.js";
import { verifyAdmin } from "../middleware/verifyRole.js";
import { saveNotification } from "../services/notifications.js";

const whole = (value) => Math.round(Number(value) || 0);
const numberOrNull = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SORTS = {
  newest: { addedAt: -1 },
  "price-asc": { effectivePrice: 1 },
  "price-desc": { effectivePrice: -1 },
  discount: { discount: -1 },
  name: { name: 1 },
};

// Menu listing shared by /foods and /foods/offer. Prices are compared after the
// discount, which is what the customer pays.
async function listFoods(foodsCollection, query, { offersOnly = false } = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(48, Math.max(1, Number.parseInt(query.limit, 10) || 12));
  const search = typeof query.search === "string" ? query.search.trim() : "";
  const minPrice = numberOrNull(query.minPrice);
  const maxPrice = numberOrNull(query.maxPrice);
  const minDiscount = numberOrNull(query.minDiscount);

  const match = {};
  if (search) {
    const pattern = new RegExp(escapeRegex(search), "i");
    match.$or = [{ name: pattern }, { description: pattern }];
  }
  if (offersOnly || query.onOffer === "true") match.discount = { $gt: 0 };
  if (minDiscount !== null && minDiscount > 0) {
    match.discount = { ...(match.discount || {}), $gte: minDiscount };
  }
  if (query.available === "true") match.available = { $ne: false };
  if (query.available === "false") match.available = false;

  const priceMatch = {};
  if (minPrice !== null) priceMatch.$gte = minPrice;
  if (maxPrice !== null) priceMatch.$lte = maxPrice;

  const pipeline = [
    { $match: match },
    {
      $addFields: {
        effectivePrice: {
          $round: [
            {
              $subtract: [
                "$price",
                { $divide: [{ $multiply: ["$price", { $ifNull: ["$discount", 0] }] }, 100] },
              ],
            },
            0,
          ],
        },
      },
    },
    ...(Object.keys(priceMatch).length ? [{ $match: { effectivePrice: priceMatch } }] : []),
    { $sort: { ...(SORTS[query.sort] || SORTS.newest), _id: 1 } },
    {
      $facet: {
        foods: [{ $skip: (page - 1) * limit }, { $limit: limit }],
        total: [{ $count: "count" }],
      },
    },
  ];

  const [result] = await foodsCollection.aggregate(pipeline).toArray();
  return { foods: result.foods, total: result.total[0]?.count || 0 };
}

export default (foodsCollection, notificationsCollection) => {
  router.get("/", async (req, res) => {
    try {
      res.send(await listFoods(foodsCollection, req.query));
    } catch (err) {
      res
        .status(500)
        .send({ message: "Failed to fetch foods", error: err.message });
    }
  });

  router.get("/random", async (req, res) => {
    try {
      const foods = await foodsCollection
        .aggregate([{ $sample: { size: 6 } }])
        .toArray();

      res.send(foods);
    } catch (err) {
      res
        .status(500)
        .send({ message: "Failed to fetch foods", error: err.message });
    }
  });

  router.get("/offer", async (req, res) => {
    try {
      res.send(await listFoods(foodsCollection, req.query, { offersOnly: true }));
    } catch (err) {
      res
        .status(500)
        .send({ message: "Failed to fetch foods", error: err.message });
    }
  });

  router.get("/offer/random", async (req, res) => {
    try {
      const foods = await foodsCollection
        .aggregate([
          { $match: { discount: { $gt: 0 } } },
          { $sample: { size: 3 } },
        ])
        .toArray();

      res.send(foods);
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
        price: whole(price),
        discount: whole(discount),
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

      await saveNotification(notificationsCollection, notification);

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

      const newPrice = whole(price);
      const newDiscount = whole(discount);

      const updateDoc = {
        $set: {
          name,
          price: newPrice,
          discount: newDiscount,
          description,
          available,
          image,
          updatedAt: new Date().toISOString(),
        },
      };

      const result = await foodsCollection.updateOne(query, updateDoc);

      if (newDiscount > food.discount) {
        const notification = {
          type: "broadcast",
          message: `Discount added on food item: ${food.name}.`,
          relatedId: foodId.toString(),
          createdAt: new Date().toISOString(),
          readBy: [],
        };

        await saveNotification(notificationsCollection, notification);
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
