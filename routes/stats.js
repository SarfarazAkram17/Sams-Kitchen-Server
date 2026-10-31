import express from "express";
import { ObjectId } from "mongodb";
const router = express.Router();
import verifyJwt from "../middleware/verifyJwt.js";
import verifyAdmin from "../middleware/verifyAdmin.js";
import verifyCustomer from "../middleware/verifyCustomer.js";
import verifyRider from "../middleware/verifyRider.js";

// ---------------------------------------------------------------------------
// Time helpers. The business operates in Bangladesh (UTC+6, no DST), so every
// bucket is computed in Asia/Dhaka to keep "today" and "this month" honest.
// ---------------------------------------------------------------------------
const TZ = "Asia/Dhaka";
const OFFSET_MS = 6 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");
const localNow = () => new Date(Date.now() + OFFSET_MS);
const monthKey = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
const dayKey = (d) => `${monthKey(d)}-${pad(d.getUTCDate())}`;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const lastMonths = (n) => {
  const now = localNow();
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (n - 1 - i), 1));
    return {
      key: monthKey(d),
      month: `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
      label: d.getUTCMonth() === 0 ? `${MONTHS[0]} ’${String(d.getUTCFullYear()).slice(2)}` : MONTHS[d.getUTCMonth()],
    };
  });
};

const lastDays = (n) => {
  const now = localNow();
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (n - 1 - i)));
    return {
      key: dayKey(d),
      label: String(d.getUTCDate()),
      date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`,
      startIso: new Date(d.getTime() - OFFSET_MS).toISOString(),
    };
  });
};

// Drop empty months before the first real activity (keep at least `min`).
const trimLeading = (series, hasData, min = 6) => {
  const first = series.findIndex(hasData);
  if (first === -1) return series.slice(-min);
  return series.slice(Math.min(first, series.length - min));
};

const trend = (current, previous) => ({
  current: round2(current),
  previous: round2(previous),
  change: previous > 0 ? round2(((current - previous) / previous) * 100) : null,
});

const sumRange = (rows, from, to, field) =>
  rows.slice(from, to).reduce((sum, row) => sum + (row[field] || 0), 0);

// Rider pay: the delivery charge, or a flat 30/50 when delivery was free.
const earningExpr = {
  $cond: [
    { $eq: ["$deliveryCharge", 0] },
    { $cond: [{ $gt: [{ $size: { $ifNull: ["$items", []] } }, 1] }, 50, 30] },
    { $ifNull: ["$deliveryCharge", 0] },
  ],
};

const fullName = (customer = {}) =>
  [customer.firstName, customer.lastName].filter(Boolean).join(" ") || customer.email || "Customer";

export default (usersCollection, ordersCollection, ridersCollection, foodsCollection) => {
  // Group orders by a formatted date field, returning Map(key -> row).
  const bucketed = async (match, field, format, accumulators, since) => {
    const rows = await ordersCollection
      .aggregate([
        {
          $match: {
            ...match,
            [field]: { $type: ["string", "date"], ...(since ? { $gte: since } : {}) },
          },
        },
        {
          $group: {
            _id: { $dateToString: { format, date: { $toDate: `$${field}` }, timezone: TZ } },
            ...accumulators,
          },
        },
      ])
      .toArray();
    return new Map(rows.map((row) => [row._id, row]));
  };

  const statusCountsFor = async (match = {}) => {
    const rows = await ordersCollection
      .aggregate([{ $match: match }, { $group: { _id: { $ifNull: ["$status", "unknown"] }, count: { $sum: 1 } } }])
      .toArray();
    return Object.fromEntries(rows.map(({ _id, count }) => [_id, count]));
  };

  const hourlySeries = (map, field = "orders") =>
    Array.from({ length: 24 }, (_, hour) => ({
      hour,
      label: `${pad(hour)}:00`,
      [field]: map.get(pad(hour))?.[field] || 0,
    }));

  const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const weekdaySeries = (map, field = "orders") =>
    WEEKDAYS.map((day, i) => ({ day, [field]: map.get(String(i + 1))?.[field] || 0 }));

  // Resolve the display names for a list of { _id: foodId } rows.
  const withFoodNames = async (rows) => {
    const ids = rows.map((r) => r._id).filter((id) => ObjectId.isValid(id));
    const foods = ids.length
      ? await foodsCollection
          .find({ _id: { $in: ids.map((id) => new ObjectId(id)) } })
          .project({ name: 1, image: 1 })
          .toArray()
      : [];
    const byId = new Map(foods.map((f) => [String(f._id), f]));
    return rows.map((r) => ({
      foodId: r._id,
      name: r.name || byId.get(String(r._id))?.name || "Removed dish",
      image: byId.get(String(r._id))?.image || null,
      quantity: r.quantity,
      revenue: round2(r.revenue),
    }));
  };

  const topFoodsFor = async (match, limit = 6) => {
    const rows = await ordersCollection
      .aggregate([
        { $match: { ...match, status: { $ne: "cancelled" } } },
        { $unwind: "$items" },
        {
          $group: {
            _id: "$items.foodId",
            name: { $first: "$items.name" },
            quantity: { $sum: "$items.quantity" },
            revenue: { $sum: { $ifNull: ["$items.subtotal", 0] } },
          },
        },
        { $sort: { quantity: -1, revenue: -1 } },
        { $limit: limit },
      ])
      .toArray();
    return withFoodNames(rows);
  };

  // ------------------------------------------------------------------ customer
  router.get("/customer", verifyJwt, verifyCustomer, async (req, res) => {
    try {
      const { email } = req.query;
      if (!email) return res.status(400).json({ message: "Email is required" });

      const query = { "customer.email": email };
      const paid = { ...query, payment_status: "paid" };
      const months = lastMonths(12);

      const [statusCounts, spendAgg, monthlyOrdersMap, monthlyPaidMap, weekdayMap, favouriteFoods, recent] =
        await Promise.all([
          statusCountsFor(query),
          ordersCollection
            .aggregate([
              { $match: paid },
              {
                $group: {
                  _id: null,
                  spent: { $sum: "$total" },
                  saved: { $sum: { $ifNull: ["$discount", 0] } },
                  count: { $sum: 1 },
                  largest: { $max: "$total" },
                },
              },
            ])
            .toArray(),
          bucketed(query, "placedAt", "%Y-%m", { orders: { $sum: 1 } }),
          bucketed(paid, "paidAt", "%Y-%m", { spent: { $sum: "$total" } }),
          bucketed({ ...query, status: { $ne: "cancelled" } }, "placedAt", "%u", { orders: { $sum: 1 } }),
          topFoodsFor(query, 6),
          ordersCollection
            .find(query)
            .sort({ placedAt: -1 })
            .limit(5)
            .project({ items: 1, total: 1, status: 1, payment_status: 1, placedAt: 1 })
            .toArray(),
        ]);

      const spend = spendAgg[0] || {};
      const monthly = trimLeading(
        months.map((m) => ({
          ...m,
          orders: monthlyOrdersMap.get(m.key)?.orders || 0,
          spent: round2(monthlyPaidMap.get(m.key)?.spent),
        })),
        (m) => m.orders > 0 || m.spent > 0,
      );

      const totalOrders = Object.values(statusCounts).reduce((a, b) => a + b, 0);

      res.status(200).send({
        totalOrders,
        completedOrders: statusCounts.delivered || 0,
        processingOrders: (statusCounts.confirmed || 0) + (statusCounts.prepared || 0),
        dispatchedOrders: statusCounts.picked || 0,
        assignedOrders: statusCounts.assigned || 0,
        statusCounts,
        totalSpent: round2(spend.spent),
        totalSaved: round2(spend.saved),
        paidOrders: spend.count || 0,
        largestOrder: round2(spend.largest),
        avgOrderValue: spend.count ? round2(spend.spent / spend.count) : 0,
        monthly,
        weekday: weekdaySeries(weekdayMap),
        favouriteFoods,
        recentOrders: recent.map((o) => ({
          id: String(o._id),
          items: (o.items || []).reduce((n, i) => n + (i.quantity || 0), 0),
          firstItem: o.items?.[0]?.name || "Order",
          total: round2(o.total),
          status: o.status,
          paymentStatus: o.payment_status,
          placedAt: o.placedAt,
        })),
      });
    } catch (error) {
      res.status(500).send({ message: error.message });
    }
  });

  // --------------------------------------------------------------------- admin
  router.get("/admin", verifyJwt, verifyAdmin, async (req, res) => {
    try {
      const months = lastMonths(12);
      const days = lastDays(60);
      const sinceDays = days[0].startIso;
      const paid = { payment_status: "paid" };
      const live = { status: { $ne: "cancelled" } };

      const [
        totalUsers,
        totalRiders,
        totalFoods,
        totalOrders,
        paymentsAgg,
        statusCounts,
        userRoleRows,
        monthlyOrdersMap,
        monthlyRevenueMap,
        dailyOrdersMap,
        dailyRevenueMap,
        hourlyMap,
        weekdayMap,
        topFoods,
        topAreaRows,
        topRiderRows,
        speedAgg,
        recent,
      ] = await Promise.all([
        usersCollection.countDocuments(),
        ridersCollection.countDocuments(),
        foodsCollection.countDocuments(),
        ordersCollection.countDocuments(),
        ordersCollection
          .aggregate([
            { $match: paid },
            { $group: { _id: null, total: { $sum: "$total" }, count: { $sum: 1 } } },
          ])
          .toArray(),
        statusCountsFor(),
        usersCollection.aggregate([{ $group: { _id: { $ifNull: ["$role", "customer"] }, count: { $sum: 1 } } }]).toArray(),
        bucketed({}, "placedAt", "%Y-%m", {
          orders: { $sum: 1 },
          delivered: { $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } },
        }),
        bucketed(paid, "paidAt", "%Y-%m", { revenue: { $sum: "$total" } }),
        bucketed({}, "placedAt", "%Y-%m-%d", { orders: { $sum: 1 } }, sinceDays),
        bucketed(paid, "paidAt", "%Y-%m-%d", { revenue: { $sum: "$total" } }, sinceDays),
        bucketed(live, "placedAt", "%H", { orders: { $sum: 1 } }),
        bucketed(live, "placedAt", "%u", { orders: { $sum: 1 }, revenue: { $sum: { $cond: [{ $eq: ["$payment_status", "paid"] }, "$total", 0] } } }),
        topFoodsFor({}, 6),
        ordersCollection
          .aggregate([
            { $match: { ...live, "customer.address.thana": { $type: "string" } } },
            {
              $group: {
                _id: "$customer.address.thana",
                orders: { $sum: 1 },
                revenue: { $sum: { $cond: [{ $eq: ["$payment_status", "paid"] }, "$total", 0] } },
              },
            },
            { $sort: { orders: -1, revenue: -1 } },
            { $limit: 6 },
          ])
          .toArray(),
        ordersCollection
          .aggregate([
            { $match: { status: "delivered", assigned_rider_email: { $type: "string" } } },
            {
              $group: {
                _id: "$assigned_rider_email",
                name: { $first: "$assigned_rider_name" },
                deliveries: { $sum: 1 },
                earnings: { $sum: earningExpr },
              },
            },
            { $sort: { deliveries: -1 } },
            { $limit: 5 },
          ])
          .toArray(),
        ordersCollection
          .aggregate([
            { $match: { status: "delivered", placedAt: { $type: ["string", "date"] }, deliveredAt: { $type: ["string", "date"] } } },
            { $group: { _id: null, avgMs: { $avg: { $subtract: [{ $toDate: "$deliveredAt" }, { $toDate: "$placedAt" }] } } } },
          ])
          .toArray(),
        ordersCollection
          .find({})
          .sort({ placedAt: -1 })
          .limit(6)
          .project({ customer: 1, items: 1, total: 1, status: 1, payment_status: 1, placedAt: 1 })
          .toArray(),
      ]);

      const pay = paymentsAgg[0] || {};
      const totalPayments = pay.total || 0;

      const monthly = trimLeading(
        months.map((m) => ({
          ...m,
          orders: monthlyOrdersMap.get(m.key)?.orders || 0,
          delivered: monthlyOrdersMap.get(m.key)?.delivered || 0,
          cancelled: monthlyOrdersMap.get(m.key)?.cancelled || 0,
          revenue: round2(monthlyRevenueMap.get(m.key)?.revenue),
        })),
        (m) => m.orders > 0 || m.revenue > 0,
      );

      const dailyFull = days.map((d) => ({
        key: d.key,
        label: d.label,
        date: d.date,
        orders: dailyOrdersMap.get(d.key)?.orders || 0,
        revenue: round2(dailyRevenueMap.get(d.key)?.revenue),
      }));
      const daily = dailyFull.slice(30);

      const notCancelled = totalOrders - (statusCounts.cancelled || 0);
      const paidCount = pay.count || 0;

      res.status(200).send({
        totalUsers,
        totalRiders,
        totalFoods,
        totalOrders,
        totalPayments: round2(totalPayments),
        statusCounts,
        cancelledOrders: statusCounts.cancelled || 0,
        monthly,
        daily,
        trends: {
          orders: trend(sumRange(dailyFull, 30, 60, "orders"), sumRange(dailyFull, 0, 30, "orders")),
          revenue: trend(sumRange(dailyFull, 30, 60, "revenue"), sumRange(dailyFull, 0, 30, "revenue")),
        },
        avgOrderValue: paidCount ? round2(totalPayments / paidCount) : 0,
        paidOrders: paidCount,
        paymentRate: notCancelled > 0 ? round2((paidCount / notCancelled) * 100) : 0,
        deliveryRate: totalOrders > 0 ? round2(((statusCounts.delivered || 0) / totalOrders) * 100) : 0,
        cancellationRate: totalOrders > 0 ? round2(((statusCounts.cancelled || 0) / totalOrders) * 100) : 0,
        avgDeliveryMinutes: speedAgg[0]?.avgMs ? Math.round(speedAgg[0].avgMs / 60000) : 0,
        userRoles: userRoleRows.map(({ _id, count }) => ({ role: _id, count })),
        hourly: hourlySeries(hourlyMap),
        weekday: weekdaySeries(weekdayMap).map((d, i) => ({ ...d, revenue: round2(weekdayMap.get(String(i + 1))?.revenue) })),
        topFoods,
        topAreas: topAreaRows.map((r) => ({ area: r._id, orders: r.orders, revenue: round2(r.revenue) })),
        topRiders: topRiderRows.map((r) => ({
          email: r._id,
          name: r.name || r._id.split("@")[0],
          deliveries: r.deliveries,
          earnings: round2(r.earnings),
        })),
        recentOrders: recent.map((o) => ({
          id: String(o._id),
          customer: fullName(o.customer),
          items: (o.items || []).reduce((n, i) => n + (i.quantity || 0), 0),
          total: round2(o.total),
          status: o.status,
          paymentStatus: o.payment_status,
          placedAt: o.placedAt,
        })),
      });
    } catch (error) {
      res.status(500).send({ message: error.message });
    }
  });

  // --------------------------------------------------------------------- rider
  router.get("/rider", verifyJwt, verifyRider, async (req, res) => {
    try {
      const { email } = req.query;
      if (!email) return res.status(400).json({ message: "Email is required" });

      const query = { assigned_rider_email: email };
      const delivered = { ...query, status: "delivered" };
      const months = lastMonths(12);
      const days = lastDays(60);
      const sinceDays = days[0].startIso;
      const earnAcc = { earnings: { $sum: earningExpr }, orders: { $sum: 1 } };

      const [
        statusCounts,
        totalsAgg,
        monthlyMap,
        dailyMap,
        hourlyMap,
        weekdayMap,
        areaRows,
        speedAgg,
        recent,
      ] = await Promise.all([
        statusCountsFor(query),
        ordersCollection
          .aggregate([
            { $match: delivered },
            {
              $group: {
                _id: null,
                earnings: { $sum: earningExpr },
                cashedOut: { $sum: { $cond: [{ $eq: ["$cashout_status", "cashed_out"] }, earningExpr, 0] } },
                pendingCashout: { $sum: { $cond: [{ $ne: ["$cashout_status", "cashed_out"] }, earningExpr, 0] } },
                cashedOutCount: { $sum: { $cond: [{ $eq: ["$cashout_status", "cashed_out"] }, 1, 0] } },
              },
            },
          ])
          .toArray(),
        bucketed(delivered, "deliveredAt", "%Y-%m", earnAcc),
        bucketed(delivered, "deliveredAt", "%Y-%m-%d", earnAcc, sinceDays),
        bucketed(delivered, "deliveredAt", "%H", { orders: { $sum: 1 } }),
        bucketed(delivered, "deliveredAt", "%u", earnAcc),
        ordersCollection
          .aggregate([
            { $match: { ...delivered, "customer.address.thana": { $type: "string" } } },
            { $group: { _id: "$customer.address.thana", deliveries: { $sum: 1 }, earnings: { $sum: earningExpr } } },
            { $sort: { deliveries: -1 } },
            { $limit: 6 },
          ])
          .toArray(),
        ordersCollection
          .aggregate([
            { $match: { ...delivered, deliveredAt: { $type: ["string", "date"] } } },
            {
              $group: {
                _id: null,
                avgMs: {
                  $avg: {
                    $subtract: [
                      { $toDate: "$deliveredAt" },
                      { $toDate: { $ifNull: ["$assignedAt", "$placedAt"] } },
                    ],
                  },
                },
                fastestMs: {
                  $min: {
                    $subtract: [
                      { $toDate: "$deliveredAt" },
                      { $toDate: { $ifNull: ["$assignedAt", "$placedAt"] } },
                    ],
                  },
                },
              },
            },
          ])
          .toArray(),
        ordersCollection
          .find(query)
          .sort({ placedAt: -1 })
          .limit(6)
          .project({ customer: 1, items: 1, deliveryCharge: 1, status: 1, placedAt: 1, deliveredAt: 1 })
          .toArray(),
      ]);

      const totals = totalsAgg[0] || {};
      const totalOrders = Object.values(statusCounts).reduce((a, b) => a + b, 0);
      const completedOrders = statusCounts.delivered || 0;

      const monthly = trimLeading(
        months.map((m) => ({
          ...m,
          earnings: round2(monthlyMap.get(m.key)?.earnings),
          orders: monthlyMap.get(m.key)?.orders || 0,
        })),
        (m) => m.orders > 0,
      );

      const dailyFull = days.map((d) => ({
        key: d.key,
        label: d.label,
        date: d.date,
        earnings: round2(dailyMap.get(d.key)?.earnings),
        orders: dailyMap.get(d.key)?.orders || 0,
      }));

      res.status(200).send({
        totalOrders,
        totalEarnings: round2(totals.earnings),
        pickedOrders: statusCounts.picked || 0,
        pendingOrders: statusCounts.assigned || 0,
        completedOrders,
        statusCounts,
        cashoutMoney: round2(totals.cashedOut),
        pendingCashout: round2(totals.pendingCashout),
        monthly,
        daily: dailyFull.slice(30),
        trends: {
          earnings: trend(sumRange(dailyFull, 30, 60, "earnings"), sumRange(dailyFull, 0, 30, "earnings")),
          deliveries: trend(sumRange(dailyFull, 30, 60, "orders"), sumRange(dailyFull, 0, 30, "orders")),
        },
        avgEarningPerDelivery: completedOrders ? round2((totals.earnings || 0) / completedOrders) : 0,
        avgDeliveryMinutes: speedAgg[0]?.avgMs ? Math.round(speedAgg[0].avgMs / 60000) : 0,
        fastestDeliveryMinutes: speedAgg[0]?.fastestMs ? Math.max(1, Math.round(speedAgg[0].fastestMs / 60000)) : 0,
        completionRate: totalOrders ? round2((completedOrders / totalOrders) * 100) : 0,
        hourly: hourlySeries(hourlyMap),
        weekday: weekdaySeries(weekdayMap, "orders").map((d, i) => ({
          ...d,
          earnings: round2(weekdayMap.get(String(i + 1))?.earnings),
        })),
        topAreas: areaRows.map((r) => ({ area: r._id, deliveries: r.deliveries, earnings: round2(r.earnings) })),
        recentDeliveries: recent.map((o) => ({
          id: String(o._id),
          customer: fullName(o.customer),
          area: o.customer?.address?.thana || "",
          items: (o.items || []).reduce((n, i) => n + (i.quantity || 0), 0),
          status: o.status,
          placedAt: o.placedAt,
          deliveredAt: o.deliveredAt || null,
        })),
      });
    } catch (error) {
      res.status(500).send({ message: error.message });
    }
  });

  return router;
};