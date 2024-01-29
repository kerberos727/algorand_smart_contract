const mongoose = require('mongoose');
require('dotenv').config()
/////////////////////////////////////////////////////////////////////////
// Mongoose connections
let dbURI = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.xzkwwst.mongodb.net/?retryWrites=true&w=majority`
// let dbURI = `mongodb://localhost:27017`

mongoose.connect(dbURI, { useNewUrlParser: true, useUnifiedTopology: true });

mongoose.connection.on("connected", () => {
  console.log("Mongoose is connected")
})

mongoose.connection.on("disconnected", () => {
  console.log("Mongoose disconnected")
  process.exit(1);
})

mongoose.connection.on('error', function (err) {//any error
  console.log('Mongoose connection error: ', err);
  process.exit(1);
});

process.on('SIGINT', function () {  //this function will run jst before app is closing
  console.log("app is terminating");
  mongoose.connection.close(function () {
    console.log('Mongoose default connection closed');
    process.exit(0);
  });
});
/////////////////////////////////////////////////////////////////////////
// Db Schemas & Models

var assetSchema = new mongoose.Schema({
  assetId: { type: String },
  price: { type: String },
  owner: { type: String },
  firstOwner: { type: String },
  isFeatured: { type: Boolean, default: false },
  createdOn: { type: Date, default: Date.now },
});

var assetsModel = mongoose.model("assets", assetSchema);

var assetDetailsSchema = new mongoose.Schema({
  assetId: { type: String },
  owner: { type: String },
  lastClaimedAt: { type: Date, default: Date.now },
  createdOn: { type: Date, default: Date.now },
});

var assetsDetailsModel = mongoose.model("assetsDetails", assetDetailsSchema);

var transactionSchema = new mongoose.Schema({
  transactionId: { type: String },
  createdOn: { type: Date, default: Date.now },
});

var transactionsModel = mongoose.model("transactions", transactionSchema);


var assetCanvasSchema = new mongoose.Schema({
  assetId: { type: String },
  owner: { type: String },
  position: {type: String},
  name: {type: String},
  createdOn: { type: Date, default: Date.now },
});

var assetCanvasModel = mongoose.model("assetCanvas", assetCanvasSchema);

module.exports = {
  assetsModel,
  assetsDetailsModel,
  transactionsModel,
  assetCanvasModel
}