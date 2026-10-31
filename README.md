# Sam's Kitchen: API

Express REST API for Sam's Kitchen, a single-restaurant food ordering and delivery platform for Bangladesh. It handles authentication cookies, menu and reviews, orders and payments, the kitchen step, rider delivery and cashouts, dashboard statistics and live notifications.

The web client lives in `../sam's-kitchen-client`. See its README for the screens and routes.

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

The API listens on `PORT` (default `3000`). In development the web client reaches it through the Vite proxy. CORS allows `CLIENT_ORIGIN` and `http://localhost:5173`.

### Environment

Create `.env` (already git-ignored). Never commit it or paste its values anywhere public.

| Variable                     | Purpose                                                                                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DB_USER`, `DB_PASS`         | MongoDB Atlas credentials. The database is named `Sams-Kitchen`.                                                                                      |
| `JWT_SECRET`                 | Signs the auth cookie and hashes verification codes                                                                                                   |
| `PAYMENT_GATEWAY_KEY`        | Stripe **secret** key                                                                                                                                 |
| `STORE_ID`, `STORE_PASSWORD` | SSLCommerz store credentials                                                                                                                          |
| `EMAIL`, `PASS`              | Gmail address and app password used to send verification codes                                                                                        |
| `CLIENT_ORIGIN`              | Deployed web client origin, allowed by CORS                                                                                                           |
| `NODE_ENV`                   | Set to `production` for secure, cross-site cookies                                                                                                    |
| `OTP_ADMIN_EMAIL`            | Optional. Inbox for admin notifications and pickup codes. It falls back to a built-in default (`config/admin.js`), so set it for your own deployment. |
| `PORT`                       | Optional. Defaults to `3000`                                                                                                                          |

### Scripts

| Command     | Does          |
| ----------- | ------------- |
| `npm start` | Start the API |

`npm test` is a placeholder. There are no automated tests yet.

## Project structure

```
index.js                app setup, CORS, route mounting
vercel.json             Vercel configuration
config/
├── db.js               MongoDB connection and collections
├── stripe.js           Stripe client
└── admin.js            admin inbox address
middleware/
├── verifyJwt.js        checks the cookie and that ?email= matches it
├── verifyAdmin.js      admin only (role from the token)
├── verifyRider.js      rider only (role from the token)
└── verifyCustomer.js   customer only (role read from the database)
services/
├── notifications.js    saves notifications and streams them over SSE
└── deliveryOtpEmail.js sends pickup and delivery codes
routes/                 auth, foods, orders, payments, riders, cashouts,
                        notifications, reviews, stats, users
```

## Authentication and access

1. The client signs in with Firebase, then calls `POST /auth/jwt` with the email. The API sets an HTTP-only `token` cookie (one day).
2. Protected routes use `verifyJwt`, which checks the cookie and requires the `?email=` query parameter to match the signed identity.
3. Role middleware restricts routes further. `verifyCustomer` reads the role from the database rather than the token, so a customer who was just approved as a rider (or made admin) loses customer access immediately. Admins and riders cannot place orders or pay.

There is no endpoint that creates an admin. Set `role: "admin"` on the user document in MongoDB.

## API reference

Paths are relative to the API origin.

| Area          | Routes                                                                                                                  | Access                |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Auth          | `POST /auth/jwt`, `POST /auth/logout`                                                                                   | Public                |
| Users         | `POST /users`, `GET /users/:email/role`                                                                                 | Public                |
|               | `PATCH /users`                                                                                                          | Signed in             |
|               | `GET /users`                                                                                                            | Admin                 |
| Menu          | `GET /foods`, `/foods/random`, `/foods/offer`, `/foods/offer/random`, `/foods/search`, `/foods/:id`, `POST /foods/cart` | Public                |
|               | `POST /foods`, `PATCH /foods/:id`, `DELETE /foods/:id`                                                                  | Admin                 |
| Reviews       | `GET /reviews`                                                                                                          | Public                |
|               | `POST /reviews`                                                                                                         | Signed in             |
| Orders        | `POST /orders`                                                                                                          | Customer              |
|               | `GET /orders`, `GET /orders/:id`, `PATCH /orders/:id` (cancel while unpaid)                                             | Signed in, own orders |
|               | `GET /orders/kitchen`, `PATCH /orders/:id/prepared`                                                                     | Admin                 |
|               | `POST /orders/:id/accept`, `POST /orders/:id/status-otp`, `PATCH /orders/:id/status`                                    | Rider                 |
| Payments      | `POST /payments/create-payment-intent`, `POST /payments/create-ssl-payment`, `POST /payments`                           | Customer              |
|               | `POST /payments/success-payment`, `/fail-payment`, `/cancel-payment`                                                    | SSLCommerz callbacks  |
| Riders        | `POST /riders`                                                                                                          | Customer              |
|               | `GET /riders/pending`, `PATCH /riders/:id/status`, `DELETE /riders/:id`                                                 | Admin                 |
|               | `GET /riders/me`, `/riders/offers`, `/riders/orders`, `/riders/completedOrders`, `PATCH /riders/me/availability`        | Rider                 |
| Cashouts      | `GET /cashouts/balance`, `GET /cashouts/me`, `POST /cashouts`                                                           | Rider                 |
|               | `GET /cashouts`, `PATCH /cashouts/:id/cashed-out`                                                                       | Admin                 |
| Notifications | `GET /notifications`, `GET /notifications/stream` (SSE), `PATCH /notifications/readAll`                                 | Signed in             |
| Stats         | `GET /stats/customer`, `/stats/admin`, `/stats/rider`                                                                   | Matching role         |

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

Riders only see orders that are `prepared` and paid in their own thana. Administrators prepare orders and review rider applications but do not assign deliveries.

### Verification codes

Before pickup the rider requests a six-digit code, which is emailed to the admin inbox. Before delivery it is emailed to the customer's order email. Codes are stored as an HMAC hash, expire after 5 minutes, allow 5 attempts and are deleted after use. `EMAIL` and `PASS` must be configured for these actions.

## Rider cashouts

- **Available balance:** delivered orders not yet part of a request. Per order the rider earns the delivery charge, or ৳30 / ৳50 (50 when the order has more than one item) when the customer's delivery was free.
- **`POST /cashouts`:** the rider submits one request for the whole available balance. The included orders are locked to the request (`cashout_status: "requested"`, `cashoutRequestId`), so the same earnings cannot be requested twice. If saving the request fails, the lock is released.
- **Methods and details** (validated on the server, unknown fields are dropped):

  | Method           | Details                                                                                            |
  | ---------------- | -------------------------------------------------------------------------------------------------- |
  | `bkash`, `nagad` | 11-digit mobile number, account type `personal` or `agent`                                         |
  | `rocket`         | 11 or 12-digit number, account type                                                                |
  | `card`           | Card holder name, card number (13 to 19 digits), issuing bank. CVV and expiry are never collected. |
  | `bank`           | Account holder, bank name, branch name, account number (6 to 20 digits)                            |

- **`PATCH /cashouts/:id/cashed-out`:** the admin sends the money outside the app, then marks the request cashed out. A proof image is required and must be an `https://res.cloudinary.com` URL. An optional transaction ID and note are stored. The request becomes `cashed_out`, its orders get `cashout_status: "cashed_out"`, and the rider is notified.
- Request statuses are `pending` and `cashed_out`. Riders read their own requests, including the proof, from `GET /cashouts/me`.

## Live notifications

`GET /notifications/stream` opens an authenticated server-sent event stream. The user comes from the verified cookie, never from a client-supplied email. New notifications are pushed to connected clients and keep-alives hold the connection open. `GET /notifications` stays available for history and as a refresh fallback.

Connections are kept in memory, so live delivery needs a persistent Node.js process. On serverless hosting or with several instances, clients fall back to refreshing, and a shared event channel would be needed for true live delivery.

## Data model

MongoDB database `Sams-Kitchen`:

| Collection                        | Holds                                                           |
| --------------------------------- | --------------------------------------------------------------- |
| `usersCollection`                 | Accounts and roles                                              |
| `foodsCollection`                 | Menu items                                                      |
| `reviewsCollection`               | Dish reviews                                                    |
| `ordersCollection`                | Orders, status timestamps, `cashout_status`, `cashoutRequestId` |
| `paymentsCollection`              | Payment records                                                 |
| `ridersCollection`                | Rider applications, approval status, availability               |
| `cashoutsCollection`              | Rider cashout requests, payout details, proof URL               |
| `notificationsCollection`         | Per-user notifications                                          |
| `deliveryOtpChallengesCollection` | Hashed pickup and delivery codes                                |

### Upgrading an existing database

Earlier versions used one `not_assigned` status for paid orders waiting for a rider. Move those once:

```js
db.ordersCollection.updateMany(
  { status: "not_assigned" },
  { $set: { status: "prepared" } },
);
```

## Deployment

`vercel.json` configures Vercel. Set every variable above in the host, and set `NODE_ENV=production`.

These production URLs are hard-coded in `routes/payments.js` and must be changed for another deployment: the SSLCommerz success, fail, cancel and IPN URLs (the API's own address) and the redirects back to the client (the web app's address). The SSLCommerz endpoints in that file are the sandbox ones.

## Known limitations

- **Sign-in is not verified server-side.** `POST /auth/jwt` issues a token for any registered email without checking the Firebase sign-in. Verify the Firebase ID token with the Firebase Admin SDK before production use.
- **Order totals come from the client.** `POST /orders` stores the submitted prices and delivery charge, and the SSLCommerz and Stripe amounts are based on them. The server does not recompute them.
- The `ipn_url` sent to SSLCommerz has no matching route.
- Card numbers entered for payouts are stored as typed so the admin can send the money.
- There are no automated tests.