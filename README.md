# Sam's Kitchen: Server

REST API for **Sam's Kitchen**, a single-restaurant food ordering and delivery platform for Bangladesh. It handles authentication, the menu and reviews, orders and payments, the kitchen step, rider delivery and cashouts, dashboard statistics and live notifications.

- **Client:** a separate repository, _Sam's Kitchen Client_ (live site: https://sams-kitchen.netlify.app).

## Contents

- [Tech stack](#tech-stack)
- [Getting started](#getting-started)
- [Project structure](#project-structure)
- [Authentication and roles](#authentication-and-roles)
- [API reference](#api-reference)
- [Order lifecycle](#order-lifecycle)
- [Rider cashouts](#rider-cashouts)
- [Rider applications](#rider-applications)
- [Notifications](#notifications)
- [Data model](#data-model)
- [Conventions](#conventions)
- [Database migrations](#database-migrations)
- [Deployment](#deployment)
- [Known limitations](#known-limitations)

## Tech stack

- Node.js 20 or later, Express 5
- MongoDB Atlas with the official driver (a replica set is required for the rider-claim transaction)
- JSON Web Tokens in an HTTP-only cookie
- Stripe and SSLCommerz payments
- Nodemailer (Gmail) for delivery verification codes
- Server-sent events for live notifications

## Getting started

```sh
npm ci
npm start          # http://localhost:3000
```

The API listens on `PORT` (default `3000`). CORS allows `CLIENT_ORIGIN` and `http://localhost:5173`.

### Environment variables

Create `.env` (git-ignored). Never commit it.

| Variable                     | Purpose                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `DB_USER`, `DB_PASS`         | MongoDB Atlas credentials. The database is named `Sams-Kitchen`.                                                                |
| `JWT_SECRET`                 | Signs the auth cookie and hashes verification codes                                                                             |
| `PAYMENT_GATEWAY_KEY`        | Stripe **secret** key                                                                                                           |
| `STORE_ID`, `STORE_PASSWORD` | SSLCommerz store credentials                                                                                                    |
| `EMAIL`, `PASS`              | Gmail address and app password used to send verification codes                                                                  |
| `CLIENT_ORIGIN`              | Deployed web client origin, allowed by CORS                                                                                     |
| `NODE_ENV`                   | Set to `production` for secure, cross-site cookies                                                                              |
| `OTP_ADMIN_EMAIL`            | Optional. Inbox for admin notifications and pickup codes. Falls back to a default in `config/admin.js`, so set it in production |
| `PORT`                       | Optional. Defaults to `3000`                                                                                                    |

### Scripts

| Command     | Does          |
| ----------- | ------------- |
| `npm start` | Start the API |

## Project structure

```
index.js                app setup, CORS, route mounting
vercel.json             Vercel configuration
config/
├── db.js               MongoDB connection and collections
├── stripe.js           Stripe client
└── admin.js            admin inbox address
middleware/
├── verifyJwt.js        checks the cookie, that ?email= matches it, and loads the role from the database
└── verifyRole.js       verifyAdmin, verifyRider, verifyCustomer
services/
├── notifications.js    saves notifications and streams them over SSE
└── deliveryOtpEmail.js sends pickup and delivery codes
utils/
├── queryHelpers.js     search, paging and order-search helpers
└── riderProfile.js     rider profile helpers
routes/                 auth, users, roles, foods, reviews, orders, payments,
                        riders, cashouts, notifications, stats
```

## Authentication and roles

1. The client signs in with Firebase, then calls `POST /auth/jwt` with the email. The API sets an HTTP-only `token` cookie (one day) and records the sign-in time. An unknown email gets a `404`, and the client then creates the account with `POST /users` and asks again.
2. Protected routes use `verifyJwt`, which checks the cookie and requires the `?email=` query parameter to match the signed identity.
3. `verifyJwt` reads the account's role from the database on every request (the token only identifies the account), and the guards in `verifyRole.js` restrict routes further. A role change takes effect immediately. Admins and riders cannot place orders or pay.

**Roles.** Definitions live in `rolesCollection` (`key`, `label`, `description`, `icon`, `selectable`, `requiresApproval`, `isDefault`, `order`). The three defaults (customer, rider, admin) are inserted once on first start and never overwritten. Only `selectable` roles can be chosen by users; `admin` is not.

**Onboarding.**

- Email/password registration stores the chosen role with the account (`POST /users`).
- A first Google or Facebook sign-in creates the account without a role, and the client sends the person to onboarding.
- `POST /users/onboarding` stores the role. A role with `requiresApproval` (rider) also takes the phone, age, experience, region, district and thana, creates a `pending` rider application and notifies the admin.

There is no endpoint that creates an admin. Set `role: "admin"` on the user document in MongoDB.

## API reference

Paths are relative to the API origin.

| Area          | Routes                                                                                                                                                                                                                                                                          | Access                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Auth          | `POST /auth/jwt` (404 for an unknown email), `POST /auth/logout`                                                                                                                                                                                                                | Public                |
| Roles         | `GET /roles`                                                                                                                                                                                                                                                                    | Public                |
| Users         | `POST /users` (accepts only selectable roles)                                                                                                                                                                                                                                   | Public                |
|               | `GET /users/me`, `POST /users/onboarding`, `PATCH /users`                                                                                                                                                                                                                       | Signed in             |
|               | `GET /users` (filters: `search`, `role` including `none`, `provider`, `sort`, `page`, `limit`; also returns `roleCounts`)                                                                                                                                                       | Admin                 |
| Menu          | `GET /foods`, `GET /foods/offer` (filters: `search`, `sort`, `minPrice`, `maxPrice`, `available`, `onOffer`, `minDiscount`, `page`, `limit`), `/foods/random`, `/foods/offer/random`, `/foods/search`, `/foods/:id`, `POST /foods/cart`                                         | Public                |
|               | `POST /foods`, `PATCH /foods/:id`, `DELETE /foods/:id`                                                                                                                                                                                                                          | Admin                 |
| Reviews       | `GET /reviews` (filters: `foodId`, `sort`, `rating`, `withPhotos`, `page`, `limit`; returns `total` and `allTotal`)                                                                                                                                                             | Public                |
|               | `POST /reviews`                                                                                                                                                                                                                                                                 | Signed in             |
| Orders        | `POST /orders`                                                                                                                                                                                                                                                                  | Customer              |
|               | `GET /orders` (filters: `search`, `status`, `payment_status`, `sort`, `page`, `limit`), `GET /orders/:id`, `PATCH /orders/:id` (cancel while unpaid)                                                                                                                            | Signed in, own orders |
|               | `GET /orders/kitchen` (filters: `status` = `confirmed` or `prepared`, `search`, `sort`; returns `counts` for both tabs), `PATCH /orders/:id/prepared`                                                                                                                           | Admin                 |
|               | `GET /orders/all` (filters: `status`, `payment_status` = `paid` or `unpaid`, `from` and `to` as `YYYY-MM-DD`, `search`, `sort` = `newest`, `oldest`, `highest` or `lowest`, `page`, `limit`)                                                                                    | Admin                 |
|               | `POST /orders/:id/accept`, `POST /orders/:id/status-otp`, `PATCH /orders/:id/status`                                                                                                                                                                                            | Rider                 |
| Payments      | `POST /payments/create-payment-intent`, `POST /payments/create-ssl-payment`, `POST /payments`                                                                                                                                                                                   | Customer              |
|               | `POST /payments/success-payment`, `/payments/fail-payment`, `/payments/cancel-payment`                                                                                                                                                                                          | SSLCommerz callbacks  |
| Riders        | `GET /riders/pending` (filters: `status` = `pending` or `rejected`, `search`, `region`, `district`, `sort`, `page`, `limit`; returns `allPending` and `allRejected`), `PATCH /riders/:id/status` (approve, also a rejected one), `PATCH /riders/:id/reject` (optional `reason`) | Admin                 |
|               | `POST /riders/reapply`, `POST /riders/withdraw`                                                                                                                                                                                                                                 | Rider                 |
|               | `GET /riders/me`, `/riders/offers`, `/riders/orders`, `/riders/completedOrders`, `PATCH /riders/me/availability`                                                                                                                                                                | Rider                 |
| Cashouts      | `GET /cashouts/balance`, `GET /cashouts/me` (filters: `status`, `method`, `sort`), `POST /cashouts`                                                                                                                                                                             | Rider                 |
|               | `GET /cashouts` (filters: `status`, `search`, `method`, `sort`), `PATCH /cashouts/:id/cashed-out`                                                                                                                                                                               | Admin                 |
| Notifications | `GET /notifications`, `GET /notifications/stream` (SSE), `PATCH /notifications/readAll`                                                                                                                                                                                         | Signed in             |
| Stats         | `GET /stats/customer`, `/stats/admin`, `/stats/rider`                                                                                                                                                                                                                           | Matching role         |

## Order lifecycle

```
pending ──pay──▶ confirmed ──admin──▶ prepared ──rider accepts──▶ assigned ──pickup code──▶ picked ──delivery code──▶ delivered
   │
   └── customer can cancel while unpaid ──▶ cancelled
```

| Status      | Set by                       | Meaning                                                                                                                                 |
| ----------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `pending`   | `POST /orders`               | Waiting for payment. The customer can cancel.                                                                                           |
| `confirmed` | Payment success              | Paid. Shown in the admin's Kitchen Orders while the chef cooks. The admin is notified.                                                  |
| `prepared`  | `PATCH /orders/:id/prepared` | Ready. The customer and the active riders in the order's thana are notified, and it becomes a rider offer.                              |
| `assigned`  | `POST /orders/:id/accept`    | A rider claimed it. A MongoDB transaction claims the order and marks the rider as delivering, so two riders cannot take the same order. |
| `picked`    | `PATCH /orders/:id/status`   | Pickup verified with a code.                                                                                                            |
| `delivered` | `PATCH /orders/:id/status`   | Delivery verified with a code. Rider availability is restored to their saved preference.                                                |

Status timestamps stored on the order: `paidAt`, `preparedAt`, `assignedAt`, `pickedAt`, `deliveredAt`.

- **Kitchen Orders** (`GET /orders/kitchen`) lists paid orders: `confirmed` (waiting to be prepared, oldest first) and `prepared` (waiting for a rider, newest first).
- **All Orders** (`GET /orders/all`) lists every order whatever its status.
- **Riders** only see orders that are `prepared` and paid in their own thana. Administrators prepare orders and review rider applications but do not assign deliveries.

**Verification codes.** Before pickup the rider requests a six-digit code, which is emailed to the admin inbox. Before delivery it is emailed to the customer's order email. Codes are stored as an HMAC hash, expire after 5 minutes, allow 5 attempts and are deleted after use. `EMAIL` and `PASS` must be configured.

## Rider cashouts

- **Available balance:** delivered orders not yet part of a request. Per order the rider earns the delivery charge, or ৳30 / ৳50 (৳50 when the order has more than one item) when the customer's delivery was free.
- **`POST /cashouts`:** one request for the whole available balance. The included orders are locked to the request (`cashout_status: "requested"`, `cashoutRequestId`) so the same earnings cannot be requested twice. If saving fails, the lock is released.
- **`PATCH /cashouts/:id/cashed-out`:** the admin sends the money outside the app, then marks the request cashed out. A proof image is required and must be an `https://res.cloudinary.com` URL; a transaction ID and note are optional. The request becomes `cashed_out`, its orders get `cashout_status: "cashed_out"`, and the rider is notified.
- Request statuses are `pending` and `cashed_out`. Riders read their own requests, including the proof, from `GET /cashouts/me`.

Payout details are validated on the server and unknown fields are dropped:

| Method           | Details                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| `bkash`, `nagad` | 11-digit mobile number, account type `personal` or `agent`                                      |
| `rocket`         | 11 or 12-digit number, account type                                                             |
| `card`           | Card holder name, card number (13 to 19 digits), issuing bank. CVV and expiry are not collected |
| `bank`           | Account holder, bank name, branch name, account number (6 to 20 digits)                         |

## Rider applications

Onboarding creates a `pending` rider application. An admin can approve it or reject it with an optional reason (up to 300 characters). A rejection keeps the account as a rider and keeps the application with `status: "rejected"`, the reason and the time, and notifies the rider. A rejected rider cannot see offers or accept deliveries, but can update the details and apply again (`POST /riders/reapply`, back to `pending`) or switch to a customer account (`POST /riders/withdraw`). An admin can still approve a rejected application later. `GET /users/me` returns `riderStatus` and `rejectionReason` so the client can show the right screen.

## Notifications

`GET /notifications/stream` opens an authenticated server-sent event stream. The user comes from the verified cookie, never from a client-supplied email. New notifications are pushed to connected clients and keep-alives hold the connection open. `GET /notifications` stays available for history and as a refresh fallback.

Connections are kept in memory, so live delivery needs a persistent Node.js process. On serverless hosting or with several instances, clients fall back to refreshing; a shared event channel would be needed for true live delivery.

## Data model

MongoDB database `Sams-Kitchen`:

| Collection                        | Holds                                                                                        |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| `usersCollection`                 | Accounts and their role key                                                                  |
| `rolesCollection`                 | Role definitions (labels, selectable, requires approval)                                     |
| `foodsCollection`                 | Menu items                                                                                   |
| `reviewsCollection`               | Dish reviews                                                                                 |
| `ordersCollection`                | Orders, status timestamps, `cashout_status`, `cashoutRequestId`                              |
| `paymentsCollection`              | Payment records                                                                              |
| `ridersCollection`                | Rider profiles: `status` (`pending`, `active` or `rejected`), rejection reason, availability |
| `cashoutsCollection`              | Rider cashout requests, payout details, proof URL                                            |
| `notificationsCollection`         | Per-user notifications                                                                       |
| `deliveryOtpChallengesCollection` | Hashed pickup and delivery codes                                                             |

## Conventions

- **Search and filtering.** List endpoints take filters as query parameters and match in MongoDB, so a page only receives what it shows. Text search is case-insensitive and escapes special characters. Order search matches the order ID, the customer's name and phone, the delivery address and the dish names. Page size is capped at 50.
- **Amounts.** Every amount is a whole taka. Food prices and discounts are rounded when saved, order and payment totals are rounded on the server, and stats and cashout figures are rounded before they are returned. Price filters compare the price after discount.
- **Statistics.** `GET /stats/admin` and `/stats/rider` return `daily` (the last 30 days) and `monthly`. `monthly` is always January to December of the current year in Dhaka time, so monthly charts start in January and future months are empty.

## Database migrations

Earlier versions used a single `not_assigned` status for paid orders waiting for a rider. Move those once:

```js
db.ordersCollection.updateMany(
  { status: "not_assigned" },
  { $set: { status: "prepared" } },
);
```

Accounts created before roles moved to the database keep their `role` and keep working. Rider applications filed before onboarding existed are approved the normal way, and approval sets the rider role on the account.

<details>
<summary>Round older records to whole taka (optional)</summary>

Amounts are rounded when saved, but older records keep their decimals (the client shows them rounded). Back up first, then run once in `mongosh`:

```js
db.foodsCollection.updateMany({}, [
  {
    $set: {
      price: { $round: ["$price", 0] },
      discount: { $round: [{ $ifNull: ["$discount", 0] }, 0] },
    },
  },
]);

db.ordersCollection.updateMany({}, [
  {
    $set: {
      subtotal: { $round: [{ $ifNull: ["$subtotal", 0] }, 0] },
      discount: { $round: [{ $ifNull: ["$discount", 0] }, 0] },
      deliveryCharge: { $round: [{ $ifNull: ["$deliveryCharge", 0] }, 0] },
      total: { $round: [{ $ifNull: ["$total", 0] }, 0] },
      items: {
        $map: {
          input: { $ifNull: ["$items", []] },
          as: "item",
          in: {
            $mergeObjects: [
              "$$item",
              {
                price: { $round: [{ $ifNull: ["$$item.price", 0] }, 0] },
                subtotal: { $round: [{ $ifNull: ["$$item.subtotal", 0] }, 0] },
              },
            ],
          },
        },
      },
    },
  },
]);

db.paymentsCollection.updateMany({ amount: { $type: "number" } }, [
  { $set: { amount: { $round: ["$amount", 0] } } },
]);
```

Rounding older orders can leave an item line and its order total 1 taka apart.

</details>

## Deployment

The API is hosted on **Vercel**, and the web client on **Netlify** (see the client repository).

- `vercel.json` builds `index.js` with `@vercel/node` and sends every request to it.
- Set every environment variable above in the Vercel project settings, with `NODE_ENV=production` and `CLIENT_ORIGIN` set to the Netlify site URL.
- Vercel runs the API as serverless functions, so live notifications fall back to the client's periodic refresh (see [Notifications](#notifications)).

These URLs are hard-coded in `routes/payments.js` and must be changed for another deployment: the SSLCommerz success, fail, cancel and IPN URLs (the API's own address, currently `https://sams-kitchen.vercel.app`) and the redirects back to the client (currently `https://sams-kitchen.netlify.app`). The SSLCommerz endpoints in that file are the sandbox ones.

## Known limitations

- **Sign-in is not verified server-side.** `POST /auth/jwt` issues a token for any registered email without checking the Firebase sign-in. Verify the Firebase ID token with the Firebase Admin SDK before production use.
- **Order totals come from the client.** `POST /orders` stores the submitted prices and delivery charge, and the SSLCommerz and Stripe amounts are based on them. The server does not recompute them.
- The `ipn_url` sent to SSLCommerz has no matching route.
- Card numbers entered for payouts are stored as typed so the admin can send the money.
- There are no automated tests.