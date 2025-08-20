const express = require("express");
const router = express.Router();
const verifyJwt = require("../middleware/verifyJwt");
const verifyAdmin = require("../middleware/verifyAdmin");
const verifyCustomer = require("../middleware/verifyCustomer");
const verifyRider = require("../middleware/verifyRider");

module.exports = (
  usersCollection,
  ordersCollection,
  ridersCollection,
  foodsCollection
) => {
  router.get("/customer", verifyJwt, verifyCustomer, async (req, res) => {
    try {
      const { email } = req.query;
      const query = { "customer.email": email };

      // Count orders by status
      const totalOrders = await ordersCollection.countDocuments(query);
      const pendingOrders = await ordersCollection.countDocuments({
        ...query,
        status: "pending",
      });
      const completedOrders = await ordersCollection.countDocuments({
        ...query,
        status: "delivered",
      });
      const processingOrders = await ordersCollection.countDocuments({
        ...query,
        status: "not_assigned",
      });
      const dispatchedOrders = await ordersCollection.countDocuments({
        ...query,
        status: "picked",
      });

      // Total spent
      const totalSpentAgg = await ordersCollection
        .aggregate([
          { $match: { ...query, payment_status: "paid" } },
          { $group: { _id: null, totalSpent: { $sum: "$total" } } },
        ])
        .toArray();
      const totalSpent =
        totalSpentAgg.length > 0 ? totalSpentAgg[0].totalSpent : 0;

      // Monthly Orders
      const monthlyOrdersAgg = await ordersCollection
        .aggregate([
          { $match: query },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%b %Y",
                  date: { $toDate: "$placedAt" },
                },
              },
              orders: { $sum: 1 },
              firstDate: { $min: { $toDate: "$placedAt" } },
            },
          },
        ])
        .toArray();
      // Sort by date
      monthlyOrdersAgg.sort(
        (a, b) => new Date(a.firstDate) - new Date(b.firstDate)
      );
      const monthlyOrders = monthlyOrdersAgg.map((item) => ({
        month: item._id,
        orders: item.orders,
      }));

      // Monthly Payments
      const monthlyPaymentsAgg = await ordersCollection
        .aggregate([
          { $match: { ...query, payment_status: "paid" } },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%b %Y",
                  date: { $toDate: "$paidAt" },
                },
              },
              payments: { $sum: "$total" },
              firstDate: { $min: { $toDate: "$paidAt" } },
            },
          },
        ])
        .toArray();
      monthlyPaymentsAgg.sort(
        (a, b) => new Date(a.firstDate) - new Date(b.firstDate)
      );
      const monthlyPayments = monthlyPaymentsAgg.map((item) => ({
        month: item._id,
        payments: Number(item.payments.toFixed(2)),
      }));

      res.status(200).send({
        totalOrders,
        pendingOrders,
        completedOrders,
        processingOrders,
        dispatchedOrders,
        totalSpent,
        monthlyOrders,
        monthlyPayments,
      });
    } catch (error) {
      res.status(500).send({ message: error.message });
    }
  });

  router.get("/admin", verifyJwt, verifyAdmin, async (req, res) => {
    try {
      // --- General Stats ---
      const totalUsers = await usersCollection.countDocuments();
      const totalRiders = await ridersCollection.countDocuments();
      const totalFoods = await foodsCollection.countDocuments();
      const totalOrders = await ordersCollection.countDocuments();

      // --- Total Payments ---
      const totalPaymentsAgg = await ordersCollection
        .aggregate([
          { $match: { payment_status: "paid" } },
          { $group: { _id: null, totalPayments: { $sum: "$total" } } },
        ])
        .toArray();
      const totalPayments =
        totalPaymentsAgg.length > 0 ? totalPaymentsAgg[0].totalPayments : 0;

      // --- Orders by Status ---
      const processingOrders = await ordersCollection.countDocuments({
        status: "not_assigned",
      });
      const assignedOrders = await ordersCollection.countDocuments({
        status: "assigned",
      });
      const dispatchedOrders = await ordersCollection.countDocuments({
        status: "picked",
      });
      const completedOrders = await ordersCollection.countDocuments({
        status: "delivered",
      });

      // --- Monthly Orders ---
      const monthlyOrdersAgg = await ordersCollection
        .aggregate([
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%b %Y",
                  date: { $toDate: "$placedAt" },
                },
              },
              orders: { $sum: 1 },
              firstDate: { $min: { $toDate: "$placedAt" } }, // for sorting
            },
          },
        ])
        .toArray();

      // sort by actual date
      monthlyOrdersAgg.sort(
        (a, b) => new Date(a.firstDate) - new Date(b.firstDate)
      );

      const monthlyOrdersData = monthlyOrdersAgg.map((item) => ({
        month: item._id,
        orders: item.orders,
      }));

      // --- Monthly Payments ---
      const monthlyPaymentsAgg = await ordersCollection
        .aggregate([
          { $match: { payment_status: "paid" } },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%b %Y",
                  date: { $toDate: "$paidAt" },
                },
              },
              payments: { $sum: "$total" },
              firstDate: { $min: { $toDate: "$paidAt" } }, // for sorting
            },
          },
        ])
        .toArray();

      monthlyPaymentsAgg.sort(
        (a, b) => new Date(a.firstDate) - new Date(b.firstDate)
      );

      const monthlyPaymentsData = monthlyPaymentsAgg.map((item) => ({
        month: item._id,
        payments: Number(item.payments.toFixed(2)),
      }));

      // --- Top Ordered Foods ---
      const topFoodsData = await ordersCollection
        .aggregate([
          { $unwind: "$items" },
          {
            $group: {
              _id: "$items.foodId",
              quantity: { $sum: "$items.quantity" },
            },
          },
          { $sort: { quantity: -1 } },
          { $limit: 5 },
          {
            $addFields: { localObjId: { $toObjectId: "$_id" } },
          },
          {
            $lookup: {
              from: "foodsCollection",
              localField: "localObjId",
              foreignField: "_id",
              as: "foodDetails",
            },
          },
          { $unwind: "$foodDetails" },
          {
            $project: {
              _id: 0,
              foodId: "$_id",
              name: "$foodDetails.name",
              quantity: 1,
            },
          },
        ])
        .toArray();

      // --- Send Response ---
      res.status(200).send({
        totalUsers,
        totalRiders,
        totalFoods,
        totalOrders,
        totalPayments,
        processingOrders,
        assignedOrders,
        dispatchedOrders,
        completedOrders,
        monthlyOrdersData,
        monthlyPaymentsData,
        topFoodsData,
      });
    } catch (error) {
      res.status(500).send({ message: error.message });
    }
  });

  router.get("/rider", verifyJwt, verifyRider, async (req, res) => {
    try {
      const { email } = req.query;
      const query = { assigned_rider_email: email };

      const totalOrders = await ordersCollection.countDocuments(query);
      const pendingOrders = await ordersCollection.countDocuments({
        ...query,
        status: "assigned",
      });
      const pickedOrders = await ordersCollection.countDocuments({
        ...query,
        status: "picked",
      });
      const completedOrders = await ordersCollection.countDocuments({
        ...query,
        status: "delivered",
      });

      const totalEarningsData = await ordersCollection
        .aggregate([
          { $match: { ...query, status: "delivered" } },
          { $project: { deliveryCharge: 1, items: 1, deliveredAt: 1 } },
          {
            $group: {
              _id: null,
              totalEarnings: {
                $sum: {
                  $cond: [
                    { $eq: ["$deliveryCharge", 0] },
                    {
                      $sum: [
                        { $cond: [{ $gt: [{ $size: "$items" }, 1] }, 50, 30] },
                      ],
                    },
                    "$deliveryCharge",
                  ],
                },
              },
            },
          },
        ])
        .toArray();

      const totalEarningsAmount =
        totalEarningsData.length > 0 ? totalEarningsData[0].totalEarnings : 0;

      const cashoutMoneyData = await ordersCollection
        .aggregate([
          { $match: { ...query, cashout_status: "cashed_out" } },
          { $project: { deliveryCharge: 1, items: 1 } },
          {
            $group: {
              _id: null,
              cashoutMoney: {
                $sum: {
                  $cond: [
                    { $eq: ["$deliveryCharge", 0] },
                    {
                      $sum: [
                        { $cond: [{ $gt: [{ $size: "$items" }, 1] }, 50, 30] },
                      ],
                    },
                    "$deliveryCharge",
                  ],
                },
              },
            },
          },
        ])
        .toArray();

      const cashoutMoneyAmount =
        cashoutMoneyData.length > 0 ? cashoutMoneyData[0].cashoutMoney : 0;

      const pendingCashoutData = await ordersCollection
        .aggregate([
          { $match: { ...query, cashout_status: { $ne: "cashed_out" } } },
          { $project: { deliveryCharge: 1, items: 1 } },
          {
            $group: {
              _id: null,
              pendingCashout: {
                $sum: {
                  $cond: [
                    { $eq: ["$deliveryCharge", 0] },
                    {
                      $sum: [
                        { $cond: [{ $gt: [{ $size: "$items" }, 1] }, 50, 30] },
                      ],
                    },
                    "$deliveryCharge",
                  ],
                },
              },
            },
          },
        ])
        .toArray();

      const pendingCashoutAmount =
        pendingCashoutData.length > 0
          ? pendingCashoutData[0].pendingCashout
          : 0;

      // Monthly earnings aggregation
      const monthlyEarnings = await ordersCollection
        .aggregate([
          { $match: { ...query, status: "delivered" } },
          {
            $project: {
              yearMonth: {
                $dateFromParts: {
                  year: { $year: { $toDate: "$deliveredAt" } },
                  month: { $month: { $toDate: "$deliveredAt" } },
                },
              },
              deliveryCharge: 1,
              items: 1,
            },
          },
          {
            $group: {
              _id: "$yearMonth",
              earnings: {
                $sum: {
                  $cond: [
                    { $eq: ["$deliveryCharge", 0] },
                    {
                      $sum: [
                        { $cond: [{ $gt: [{ $size: "$items" }, 1] }, 50, 30] },
                      ],
                    },
                    "$deliveryCharge",
                  ],
                },
              },
              orders: { $sum: 1 },
            },
          },
          {
            $project: {
              _id: 0,
              month: { $dateToString: { format: "%b %Y", date: "$_id" } },
              earnings: 1,
              orders: 1,
            },
          },
          { $sort: { month: 1 } },
        ])
        .toArray();

      const formattedMonthlyEarnings = monthlyEarnings.map((m) => ({
        month: m.month,
        earnings: m.earnings,
        orders: m.orders,
      }));

      res.status(200).send({
        totalOrders,
        totalEarnings: totalEarningsAmount,
        pickedOrders,
        pendingOrders,
        completedOrders,
        cashoutMoney: cashoutMoneyAmount,
        pendingCashout: pendingCashoutAmount,
        monthlyEarnings: formattedMonthlyEarnings,
      });
    } catch (error) {
      res.status(500).send({ message: error.message });
    }
  });

  return router;
};
