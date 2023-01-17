const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
require("dotenv").config();
const nodemailer = require("nodemailer");
const mg = require("nodemailer-mailgun-transport");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

// middle wares
app.use(cors());
app.use(express.json());

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.taxrqnn.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverApi: ServerApiVersion.v1,
});

function sendBookingEmail(booking) {
  const { email, treatment, appointmentDate, slot } = booking;
  const auth = {
    auth: {
      api_key: process.env.MAILGUN_API_KEY,
      domain: process.env.MAILGUN_DOMAIN,
    },
  };

  const transporter = nodemailer.createTransport(mg(auth));

  transporter.sendMail(
    {
      from: "mizbauddintareq@gmail.com", // verified sender email
      to: email, // recipient email
      subject: `Your appointment for ${treatment} is confirmed`, // Subject line
      text: "Hello world!", // plain text body
      html: `
      <h3>Your Appointment Is Confirmed</h3>
      <div>
      <p>Your appointment for ${treatment}</p>
      <p>Please visit us on ${appointmentDate} on ${slot}</p>
      <p>Thanks from smile-care</p>
      </div>
      `, // html body
    },
    function (error, info) {
      if (error) {
        console.log(error);
      } else {
        console.log("Email sent: " + info.response);
      }
    }
  );
}

// VerifyJWT
function VerifyJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  const token = authHeader.split(" ")[1];
  jwt.verify(token, process.env.CLIENT_SECRET_TOKEN, function (err, decoded) {
    if (err) {
      return res.status(403).send({ message: "forbidden access" });
    }
    req.decoded = decoded;
    next();
  });
}

async function run() {
  try {
    const appointmentOptionCollection = client
      .db("smile_care")
      .collection("appointmentOptions");

    const bookingsCollection = client.db("smile_care").collection("bookings");
    const usersCollection = client.db("smile_care").collection("users");
    const doctorsCollection = client.db("smile_care").collection("doctors");
    const paymentsCollection = client.db("smile_care").collection("payments");

    // verifyAdmin
    const verifyAdmin = async (req, res, next) => {
      const decodedEmail = req.decoded.email;
      const query = { email: decodedEmail };
      const user = await usersCollection.findOne(query);

      if (user?.role !== "admin") {
        res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    // get all appointment options API
    app.get("/appointmentOptions", async (req, res) => {
      const date = req.query.date;
      const query = {};
      const options = await appointmentOptionCollection.find(query).toArray();

      const bookingQuery = { appointmentDate: date };
      const alreadyBooked = await bookingsCollection
        .find(bookingQuery)
        .toArray();
      options.forEach((option) => {
        const optionBooked = alreadyBooked.filter(
          (booked) => booked.treatment === option.name
        );
        const bookedSlot = optionBooked.map((booked) => booked.slot);
        const remainingSlots = option.slots.filter(
          (slot) => !bookedSlot.includes(slot)
        );
        option.slots = remainingSlots;
      });

      res.send(options);
    });

    // Get Only Appointment Specialty Name
    app.get("/appointmentSpecialty", async (req, res) => {
      const query = {};
      const specialty = await appointmentOptionCollection
        .find(query)
        .project({ name: 1 })
        .toArray();
      res.send(specialty);
    });

    //   Post booking API
    app.post("/bookings", async (req, res) => {
      const booking = req.body;
      const query = {
        email: booking.email,
        appointmentDate: booking.appointmentDate,
        treatment: booking.treatment,
      };

      const alreadyBooked = await bookingsCollection.find(query).toArray();
      if (alreadyBooked.length) {
        const message = `You already have a booking on ${booking.appointmentDate} `;
        return res.send({ acknowledge: false, message });
      }
      const result = await bookingsCollection.insertOne(booking);

      // send booking conformation email
      sendBookingEmail(booking);

      res.send(result);
    });

    // Get bookings by email API
    app.get("/bookings", VerifyJWT, async (req, res) => {
      const email = req.query.email;
      const decodedEmail = req.decoded.email;

      if (email !== decodedEmail) {
        return res.status(403).send({ message: "forbidden access" });
      }

      const query = { email: email };
      const bookings = await bookingsCollection.find(query).toArray();
      res.send(bookings);
    });

    // Get Booking by id API
    app.get("/bookings/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: ObjectId(id) };
      const booking = await bookingsCollection.findOne(query);
      res.send(booking);
    });

    // JWT
    app.get("/jwt", async (req, res) => {
      const email = req.query.email;
      const query = { email: email };
      const user = await usersCollection.findOne(query);
      if (user) {
        const token = jwt.sign({ email }, process.env.CLIENT_SECRET_TOKEN, {
          expiresIn: "1h",
        });
        return res.send({ accessToken: token });
      }
      res.status(403).send({ accessToken: "unauthorized" });
    });

    // Payment API
    app.post("/create-payment-intent", async (req, res) => {
      const booking = req.body;
      const price = booking.price;
      const amount = price * 100;

      // Create a PaymentIntent with the order amount and currency
      const paymentIntent = await stripe.paymentIntents.create({
        currency: "usd",
        amount: amount,
        payment_method_types: ["card"],
      });

      res.send({
        clientSecret: paymentIntent.client_secret,
      });
    });

    // Post Payment API
    app.post("/payment", async (req, res) => {
      const payment = req.body;
      const result = await paymentsCollection.insertOne(payment);
      const id = payment.bookingId;
      const filter = { _id: ObjectId(id) };
      const updateDoc = {
        $set: {
          paid: true,
          transactionId: payment.transactionId,
        },
      };
      const updatedInfo = await bookingsCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    // Post users API
    app.post("/users", async (req, res) => {
      const users = req.body;
      const usersInfo = await usersCollection.insertOne(users);
      res.send(usersInfo);
    });

    // Check admin API
    app.get("/users/admin/:email", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      res.send({ isAdmin: user?.role === "admin" });
    });

    // Get all users API
    app.get("/users", VerifyJWT, verifyAdmin, async (req, res) => {
      const users = await usersCollection.find({}).toArray();
      res.send(users);
    });

    // Make admin API
    app.put("/users/admin/:id", VerifyJWT, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const filter = { _id: ObjectId(id) };
      const options = { upsert: true };
      const updateDoc = {
        $set: {
          role: "admin",
        },
      };
      const result = await usersCollection.updateOne(
        filter,
        updateDoc,
        options
      );
      res.send(result);
    });

    // POST doctors API
    app.post("/doctors", VerifyJWT, verifyAdmin, async (req, res) => {
      const doctor = req.body;
      const result = await doctorsCollection.insertOne(doctor);
      res.send(result);
    });

    // GET doctors API
    app.get("/doctors", VerifyJWT, verifyAdmin, async (req, res) => {
      const query = {};
      const doctors = await doctorsCollection.find(query).toArray();
      res.send(doctors);
    });

    // DELETE doctor API
    app.delete("/doctors/:id", VerifyJWT, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const filter = { _id: ObjectId(id) };
      const result = await doctorsCollection.deleteOne(filter);
      res.send(result);
    });
  } finally {
  }
}
run().catch((err) => console.log(err));

app.get("/", (req, res) => {
  res.send("Welcome to smile care!");
});

app.listen(port, () => {
  console.log(`Smile Care listening on port ${port}`);
});
