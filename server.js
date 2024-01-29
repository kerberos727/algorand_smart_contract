const { default: algosdk } = require("algosdk");
const express = require("express");
const app = express()
const PORT = process.env.PORT || 5002;
require('dotenv').config()
app.use(express.json());
var cors = require("cors")
app.use(cors())
app.options("*", cors());
const { assetsModel, assetsDetailsModel, transactionsModel, assetCanvasModel } = require("./database/models")

let txParamsJS = {};
let algodClient = {};
let indexerClient = {};
let tnAccounts = [];
let assetsList = [];
let signedTxs;
let tx = {};

const algodServer = 'https://testnet-algorand.api.purestake.io/ps2';
const token = { 'X-API-Key': process.env.PURE_STAKE_TOKEN }
const port = '';

algodClient = new algosdk.Algodv2(token, algodServer, port);


const indexer_token = { 'X-API-Key': process.env.PURE_STAKE_TOKEN };
const indexer_server = "https://testnet-algorand.api.purestake.io/idx2";
const indexer_port = "";

indexerClient = new algosdk.Indexer(indexer_token, indexer_server, indexer_port);

async function getTransactionInfoById(txId) {
  return await indexerClient.lookupTransactionByID(txId).do()
}

async function getAssetInfoByAddress(address){
  return await indexerClient.lookupAccountAssets(address).do().catch(e => {
    console.log(e);
  })
}

app.post("/receive-asset", async (req, res, next) => {
  if (!req.body || !req.body.assetId || !req.body.txn || !req.body.receiverAddr) {
    res.status(400).send({
      success: false,
      message: "Incomplete data"
    })
    return;
  }
  console.log("REQ", req.body)

  console.log("wating for tx confirmation")
  const confirmedReqTxn = await algosdk.waitForConfirmation(algodClient, req.body.txn.txId, 4);
  console.log("Tx confirmed, Rounds: ", confirmedReqTxn["confirmed-round"])
  if (!confirmedReqTxn) {
    res.status(403).send({
      success: false,
      message: "Transaction not confirmed"
    })
  }

  // Checking id is already in database
  let transaction = await transactionsModel.findOne({ transactionId: req?.body?.txn?.txId })
  console.log("transaction", transaction)
  if (transaction) {
    console.log("this transaction is already in database")
    res.status(400).send({
      message: "unauthorize request",
      success: false,
    })
    return;
  }

  // Admin address in To:
  const txInfo = await getTransactionInfoById(req?.body?.txn?.txId);
  console.log("txInfo", txInfo)
  console.log("checking admin address in to")
  if (txInfo?.transaction["payment-transaction"].receiver != process.env.ADMIN_ADDRESS) {
    console.log("Transaction not to admin address")
    res.status(400).send({
      success: false,
      message: "Transaction not to admin address"
    })
    return;
  }

  console.log("checking Receiver address is not in sender of TX")
  // Receiver address is not in sender of TX:
  if (txInfo?.transaction?.sender != req.body.receiverAddr) {
    console.log("Transaction not to admin address")
    res.status(400).send({
      success: false,
      message: "Transaction not to admin address"
    })
    return;
  }

  console.log("checking Amount is equal or greater than price")
  // Amount is equal or greater than price
  if (txInfo?.transaction["payment-transaction"].amount < process.env.ADMIN_ASSET_PRICE) {
    console.log("Amount is less than admin asset amount")
    res.status(400).send({
      success: false,
      message: "Amount is less than admin asset amount"
    })
    return;
  }

  console.log("inserting txId in database")
  // inserting txId in database
  let newTransactionModel = new transactionsModel({
    transactionId: req?.body?.txn?.txId,
  });
  newTransactionModel.save((err, data) => {
    if (!err) {
      console.log("Inserted in DB: ", data);
    } else {
      res.status(500).send({
        success: false,
        message: "Internal server error"
      });
      console.log("Internal server error: ", err);
      return;
    }
  });


  try {
    //Amount of the asset to transfer

    const assetIndex = req.body.assetId; // identifying index of the asset

    params = await algodClient.getTransactionParams().do()

    // params.fee = 1000;
    // params.flatFee = true;

    sender = process.env.ADMIN_ADDRESS;
    recipient = req.body.receiverAddr;
    revocationTarget = undefined;
    closeRemainderTo = undefined;
    //Amount of the asset to transfer
    let amount = 1;

    // signing and sending "txn" will send "amount" assets from "sender" to "recipient"
    let xtxn = algosdk.makeAssetTransferTxnWithSuggestedParams(
      sender,
      recipient,
      closeRemainderTo,
      revocationTarget,
      amount,
      new TextEncoder("utf-8").encode(req.body.note),
      assetIndex,
      params,
    );

    let newSenderPrivate = algosdk.mnemonicToSecretKey(process.env.ADMIN_MNEMONIC);

    rawSignedTxn = xtxn.signTxn(newSenderPrivate.sk)

    let xtx = (await algodClient.sendRawTransaction(rawSignedTxn).do());

    confirmedTxn = await algosdk.waitForConfirmation(algodClient, xtx.txId, 4);
    console.log("Transaction " + xtx.txId + " confirmed in round " + confirmedTxn["confirmed-round"]);

    // await printAssetHolding(algodClient, req.body.receiverAddr, assetIndex);

    // inserting asset in assetsDetails model in database
    let newAssetDetailsModel = new assetsDetailsModel({
      assetId: req.body.assetId,
      owner: req.body.receiverAddr
    });
    newAssetDetailsModel.save((err, data) => {
      if (!err) {
        console.log("Inserted in DB: ", data);
        res.send({
          success: true,
          message: "asset transferred successfully",
          ...xtx,
          amount,
          assetId: assetIndex,
          confirmed_round: confirmedTxn["confirmed-round"]
        })
        return;
      } else {
        res.status(500).send({
          success: false,
          message: "Internal server error"
        });
        console.log("Not inserted in database: ", err);
        return;
      }
    });

  }
  catch (err) {
    console.log("Error", err)
    res.status(500).send({
      success: false,
      message: err
    })
    return;
  }

})

app.post("/receive-asset-from-escrow", async (req, res, next) => {
  if (!req.body || !req.body.assetId || !req.body.txn || !req.body.receiverAddr || !req.body.sellerAddress || !req.body.buyingPrice) {
    res.status(400).send({
      success: false,
      message: "Incomplete data"
    })
    return;
  }
  console.log("Req.body", req.body)

  console.log("wating for tx confirmation")
  const confirmedReqTxn = await algosdk.waitForConfirmation(algodClient, req.body.txn.txId, 4);
  console.log("Tx confirmed, Rounds: ", confirmedReqTxn["confirmed-round"])
  if (!confirmedReqTxn) {
    res.status(403).send({
      success: false,
      message: "Transaction not confirmed"
    })
  }

  const assetInfo = await assetsModel.findOne({ assetId: req.body.assetId });

  if (!assetInfo) {
    console.log("asset not found");
    res.status(400).send({
      success: false,
      message: "This asset not found create first",
    });
    return;
  }

  // Checking id is already in database
  let transaction = await transactionsModel.findOne({ transactionId: req?.body?.txn?.txId })
  if (transaction) {
    res.status(400).send({
      message: "unauthorize request",
      success: false,
    })
    return;
  }

  // escrow address in To:
  const txInfo = await getTransactionInfoById(req?.body?.txn?.txId);
  if (txInfo?.transaction["payment-transaction"].receiver != process.env.ESCROW_ADDRESS) {
    res.status(400).send({
      success: false,
      message: "Transaction not to escrow address"
    })
    return;
  }

  // Receiver address is not in sender of TX:
  if (txInfo?.transaction?.sender != req.body.receiverAddr) {
    res.status(400).send({
      success: false,
      message: "Transaction not to escrow address"
    })
    return;
  }

  // Amount is equal or greater than price
  if (txInfo?.transaction["payment-transaction"].amount < assetInfo.price) {
    res.status(400).send({
      success: false,
      message: "Amount is less than escrow asset amount"
    })
    return;
  }

  // inserting txId in database
  let newTransactionModel = new transactionsModel({
    transactionId: req?.body?.txn?.txId,
  });
  newTransactionModel.save((err, data) => {
    if (!err) {
      console.log("Inserted in DB: ", data);
    } else {
      res.status(500).send({
        success: false,
        message: "Internal server error"
      });
      console.log("Internal server error: ", err);
      return;
    }
  });

  try {
    const assetIndex = req.body.assetId; // identifying index of the asset

    params = await algodClient.getTransactionParams().do()

    // params.fee = 1000;
    // params.flatFee = true;

    sender = process.env.ESCROW_ADDRESS;
    recipient = req.body.receiverAddr;
    revocationTarget = undefined;
    closeRemainderTo = undefined;
    // Amount of the asset to transfer
    let amount = 1;

    // buying price minus escrow fee
    let escrowFee = 4000; // previously it was 1000 which means 0.001 Algo gas price.
    let buyingAmount = Number(Math.floor(req.body.buyingPrice - escrowFee));
    console.log("buyingAmount", buyingAmount)

    let royaltyAmountToAdmin = Number((10 / 100) * buyingAmount);
    console.log("royaltyAmountToAdmin", royaltyAmountToAdmin)

    let amountToAssetOwner = Number(buyingAmount - royaltyAmountToAdmin);
    console.log("amountToAssetOwner", amountToAssetOwner)

    let escrowPrivateKey = algosdk.mnemonicToSecretKey(process.env.ESCROW_MNEMONIC);

    // ****************** Trasnfer asset to buyer address

    let assetToBuyer = algosdk.makeAssetTransferTxnWithSuggestedParams(
      sender,
      recipient,
      closeRemainderTo,
      revocationTarget,
      amount,
      new TextEncoder("utf-8").encode(req.body.note),
      assetIndex,
      params,
    );

    // assetToBuyerSignedTxn = assetToBuyer.signTxn(escrowPrivateKey.sk)

    // let confirmedAssetToBuyer = (await algodClient.sendRawTransaction(assetToBuyerSignedTxn).do());

    // confirmedTxn = await algosdk.waitForConfirmation(algodClient, confirmedAssetToBuyer.txId, 4);
    // console.log("Transferring asset to buyer Address: ", recipient);
    // console.log("Transaction " + confirmedAssetToBuyer.txId + " confirmed in round " + confirmedTxn["confirmed-round"]);

    // ****************** Trasnfer amount to asset owner now

    const paymentToAssetOwner = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      from: process.env.ESCROW_ADDRESS,
      to: req.body.sellerAddress,
      amount: amountToAssetOwner,
      note: new TextEncoder("utf-8").encode(req.body.note),
      suggestedParams: params,
    });

    // signedPaymentToAssetOwner = paymentToAssetOwner.signTxn(escrowPrivateKey.sk)

    // let confirmedPaymentToAssetOwner = (await algodClient.sendRawTransaction(signedPaymentToAssetOwner).do());

    // confirmedTxnPaymentToAssetOwner = await algosdk.waitForConfirmation(algodClient, confirmedPaymentToAssetOwner.txId, 4);
    // console.log("Transferring amount to seller Address: ", req.body.sellerAddress);
    // console.log("Transaction " + confirmedPaymentToAssetOwner.txId + " confirmed in round " + confirmedTxnPaymentToAssetOwner["confirmed-round"]);

    // ****************** Trasnfer royalty to admin

    const paymentRoyaltyAddress = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      from: process.env.ESCROW_ADDRESS,
      to: process.env.ADMIN_ADDRESS,
      amount: royaltyAmountToAdmin,
      note: new TextEncoder("utf-8").encode(req.body.note),
      suggestedParams: params,
    });

    // signedPaymentRoyaltyAddress = paymentRoyaltyAddress.signTxn(escrowPrivateKey.sk)

    // let confirmedPaymentRoyaltyAddress = (await algodClient.sendRawTransaction(signedPaymentRoyaltyAddress).do());

    // confirmedTxnPaymentRoyaltyAddress = await algosdk.waitForConfirmation(algodClient, confirmedPaymentRoyaltyAddress.txId, 4);
    // console.log("Transferring royalty to admin address: ", process.env.ADMIN_ADDRESS);
    // console.log("Transaction " + confirmedPaymentRoyaltyAddress.txId + " confirmed in round " + confirmedTxnPaymentRoyaltyAddress["confirmed-round"]);

    // Combine transactions
    let txns = [assetToBuyer, paymentToAssetOwner, paymentRoyaltyAddress];
    // Group both transactions
    let txgroup = algosdk.assignGroupID(txns);
    // Sign each transaction in the group 
    let signedTx1 = assetToBuyer.signTxn(escrowPrivateKey.sk)
    let signedTx2 = paymentToAssetOwner.signTxn(escrowPrivateKey.sk)
    let signedTx3 = paymentRoyaltyAddress.signTxn(escrowPrivateKey.sk)
    // Assemble transaction group
    let signed = [];
    signed.push(signedTx1);
    signed.push(signedTx2);
    signed.push(signedTx3);
    // Send transaction group
    let atomicTxn = (await algodClient.sendRawTransaction(signed).do());
    console.log("atomicTxn Transaction : " + atomicTxn.txId);

    // Wait for transaction to be confirmed
    let confirmedAtomicTxn = await algosdk.waitForConfirmation(algodClient, atomicTxn.txId, 4);
    //Get the completed Transaction
    console.log("confirmedAtomicTxn Transaction " + atomicTxn.txId + " confirmed in round " + confirmedAtomicTxn["confirmed-round"]);

    // deleting asset from db
    let response = await assetsModel.deleteOne({ assetId: req.body.assetId });
    if (!response) {
      res.status(400).send({
        success: false,
        message: "Error in deleting from db",
      })
      return;
    }

    console.log("Asset successfully deleted from db")

    // inserting asset in assetsDetails model in database
    let newAssetDetailsModel = new assetsDetailsModel({
      assetId: req.body.assetId,
      owner: req.body.receiverAddr
    });
    newAssetDetailsModel.save((err, data) => {
      if (!err) {
        console.log("Inserted in DB: ", data);
        res.send({
          success: true,
          message: "asset transferred successfully",
          amount,
          assetId: assetIndex,
          confirmedAtomicTxn: confirmedAtomicTxn["confirmed-round"],
          // ...confirmedAssetToBuyer,
          // ...confirmedPaymentToAssetOwner,
          // ...confirmedTxnPaymentRoyaltyAddress,
          // confirmed_round: confirmedTxn["confirmed-round"],
          // confirmedTxnPaymentToAssetOwner: confirmedTxnPaymentToAssetOwner["confirmed-round"],
        })
        return;
      } else {
        res.status(500).send({
          success: false,
          message: "Internal server error"
        });
        console.log("Not inserted in database: ", err);
        return;
      }
    });

    return;
  }
  catch (err) {
    console.log("Error", err)
    res.status(500).send({
      success: false,
      message: err
    })
    return;
  }

})

app.post("/escrow-opt-in", async (req, res, next) => {
  if (!req.body || !req.body.assetId || !req.body.txn || !req.body.receiverAddr) {
    res.status(400).send({
      success: false,
      message: "Incomplete data"
    })
    console.log("Incomplete data")
    return;
  }
  console.log("REQ", req.body)

  console.log("wating for tx confirmation")
  const confirmedReqTxn = await algosdk.waitForConfirmation(algodClient, req.body.txn.txId, 4);
  console.log("Tx confirmed, Rounds: ", confirmedReqTxn["confirmed-round"])
  if (!confirmedReqTxn) {
    res.status(403).send({
      success: false,
      message: "Transaction not confirmed"
    })
  }

  // Checking id is already in database
  let transaction = await transactionsModel.findOne({ transactionId: req?.body?.txn?.txId })
  if (transaction) {
    res.status(400).send({
      message: "unauthorize request",
      success: false,
    })
    return;
  }

  const txInfo = await getTransactionInfoById(req?.body?.txn?.txId);
  console.log("req.body", req.body)
  console.log("txInfo", txInfo)

  // escrow address in To:
  if (txInfo?.transaction["payment-transaction"].receiver != process.env.ESCROW_ADDRESS) {
    console.log("Transaction not to escrow address")
    res.status(400).send({
      success: false,
      message: "Transaction not to escrow address"
    })
    return;
  }

  // sender of Tx and sender of this request is not same:
  if (txInfo?.transaction?.sender != req.body.receiverAddr) {
    console.log("Tx is not from this address")
    res.status(400).send({
      success: false,
      message: "Tx is not from this address"
    })
    return;
  }

  console.log("checking Amount is equal or greater than price")
  // Amount is equal or greater than price
  if (txInfo?.transaction["payment-transaction"].amount < 1000) {
    console.log("Amount is less than admin asset amount")
    res.status(400).send({
      success: false,
      message: "Amount is less than admin asset amount"
    })
    return;
  }

  console.log("inserting txId in database")
  // inserting txId in database
  let newTransactionModel = new transactionsModel({
    transactionId: req?.body?.txn?.txId,
  });
  newTransactionModel.save((err, data) => {
    if (!err) {
      console.log("Inserted in DB: ", data);
    } else {
      res.status(500).send({
        success: false,
        message: "Internal server error"
      });
      console.log("Internal server error: ", err);
      return;
    }
  });

  try {
    const assetIndex = req.body.assetId; // identifying index of the asset

    params = await algodClient.getTransactionParams().do()

    // params.fee = 1000;
    // params.flatFee = true;

    sender = process.env.ESCROW_ADDRESS;
    recipient = process.env.ESCROW_ADDRESS;
    revocationTarget = undefined;
    closeRemainderTo = undefined;
    let amount = 0;

    // signing and sending "txn" will send "amount" assets from "sender" to "recipient"
    let xtxn = algosdk.makeAssetTransferTxnWithSuggestedParams(
      sender,
      recipient,
      closeRemainderTo,
      revocationTarget,
      amount,
      new TextEncoder("utf-8").encode(req.body.note),
      assetIndex,
      params,
    );

    let newSenderPrivate = algosdk.mnemonicToSecretKey(process.env.ESCROW_MNEMONIC);

    rawSignedTxn = xtxn.signTxn(newSenderPrivate.sk)

    let xtx = (await algodClient.sendRawTransaction(rawSignedTxn).do());

    confirmedTxn = await algosdk.waitForConfirmation(algodClient, xtx.txId, 4);
    console.log("Transaction " + xtx.txId + " confirmed in round " + confirmedTxn["confirmed-round"]);

    // await printAssetHolding(algodClient, req.body.receiverAddr, assetIndex);

    res.send({
      success: true,
      message: "asset opt in successfully",
      ...xtx,
      amount,
      assetId: assetIndex,
      confirmed_round: confirmedTxn["confirmed-round"]
    })
    return;
  }
  catch (err) {
    console.log("Error", err)
    res.status(500).send({
      success: false,
      message: err
    })
    return;
  }

})

app.post("/list-my-asset", async (req, res, next) => {
  if (!req.body || !req.body.assetId || !req.body.txn || !req.body.owner || !req.body.price || !req.body.firstOwner) {
    res.status(400).send({
      success: false,
      message: "Incomplete data"
    })
    return;
  }

  console.log("wating for tx confirmation")
  const confirmedReqTxn = await algosdk.waitForConfirmation(algodClient, req.body.txn.txId, 4);
  console.log("Tx confirmed, Rounds: ", confirmedReqTxn["confirmed-round"])
  if (!confirmedReqTxn) {
    res.status(403).send({
      success: false,
      message: "Transaction not confirmed"
    })
  }

  // checking escrow have this asset and amount!=0
  const escrowInformation = await algodClient.accountInformation(process.env.ESCROW_ADDRESS).do()
  const asset = escrowInformation.assets.find((eachAsset) => eachAsset["asset-id"] == req.body.assetId)
  if (!asset || asset.amount == 0) {
    res.status(404).send({
      success: false,
      message: 'Asset not found in escrow'
    })
    return;
  }

  // Checking id is already in database
  let transaction = await transactionsModel.findOne({ transactionId: req?.body?.txn?.txId })
  if (transaction) {
    res.status(400).send({
      message: "unauthorize request",
      success: false,
    })
    return;
  }

  // escrow address in To:
  const txInfo = await getTransactionInfoById(req?.body?.txn?.txId);
  console.log("req.body", req.body)
  console.log("txInfo", txInfo)
  if (txInfo?.transaction["asset-transfer-transaction"].receiver != process.env.ESCROW_ADDRESS) {
    res.status(400).send({
      success: false,
      message: "Transaction not to escrow address"
    })
    return;
  }

  // Receiver address is not in sender of TX:
  if (txInfo?.transaction?.sender != req.body.owner) {
    res.status(400).send({
      success: false,
      message: "Transaction not to escrow address"
    })
    return;
  }

  // inserting txId in database
  let newTransactionModel = new transactionsModel({
    transactionId: req?.body?.txn?.txId,
  });
  newTransactionModel.save((err, data) => {
    if (!err) {
      console.log("Inserted in DB: ", data);
    } else {
      res.status(500).send({
        success: false,
        message: "Internal server error"
      });
      console.log("Internal server error: ", err);
      return;
    }
  });

  let newAssetModel = new assetsModel({
    assetId: req.body.assetId,
    price: req.body.price,
    owner: req.body.owner,
    firstOwner: req.body.firstOwner,
  });
  newAssetModel.save(async (err, data) => {
    if (!err) {

      assetsDetailsModel.deleteOne({ assetId: req.body.assetId })
        .then((data) => {
          if (data) {
            console.log("asset listed: ", data);
            res.send({
              success: true,
              message: "Asset is listed successfully"
            });
            return;
          }
        })
        .catch((error) => {
          console.log("Error", error);
          res.status(500).send({
            success: false,
            message: "Internal server error"
          });
          return;
        })


      return;
    } else {
      res.status(500).send({
        success: false,
        message: "Internal server error"
      });
      console.log("Internal server error: ", err);
      return;
    }
  });
  return;
})

app.post("/un-list-my-asset", async (req, res, next) => {

  if (!req.body || !req.body.assetId || !req.body.receiverAddr || !req.body.txn) {
    res.status(400).send({
      success: false,
      message: "Incomplete data"
    })
    console.log("Incomplete data");
    return;
  }
  console.log("executin asset id: ", req.body.assetId) 

  const gettingAssetInfo = await assetsModel
  .findOne({ assetId: +req.body.assetId });

  console.log("wating for tx confirmation")
  const confirmedReqTxn = await algosdk.waitForConfirmation(algodClient, req.body.txn.txId, 4);
  console.log("Tx confirmed, Rounds: ", confirmedReqTxn["confirmed-round"])
  if (!confirmedReqTxn) {
    res.status(403).send({
      success: false,
      message: "Transaction not confirmed"
    })
  }

  // Checking id is already in database
  let transaction = await transactionsModel.findOne({ transactionId: req?.body?.txn?.txId })
  console.log("transaction", transaction)
  if (transaction) {
    console.log("this transaction is already in database")
    res.status(400).send({
      message: "unauthorize request",
      success: false,
    })
    return;
  }

  // Escrow address in To:
  const txInfo = await getTransactionInfoById(req?.body?.txn?.txId);
  console.log("txInfo", txInfo)
  console.log("checking escrow address in to")
  if (txInfo?.transaction["payment-transaction"].receiver != process.env.ESCROW_ADDRESS) {
    console.log("Transaction not to admin address")
    res.status(400).send({
      success: false,
      message: "Transaction not to admin address"
    })
    return;
  }

  console.log("checking for real owner");
  if(gettingAssetInfo?.owner !== txInfo?.transaction?.sender){
    res.status(400).send({
      success: false,
      message: "Owner address mismatch!"
    })
    return;
  }
  console.log("checking Receiver address is not in sender of TX")
  // Receiver address is not in sender of TX:
  if (txInfo?.transaction?.sender != req.body.receiverAddr) {
    console.log("Transaction not to admin address")
    res.status(400).send({
      success: false,
      message: "Transaction not to admin address"
    })
    return;
  }

  console.log("checking Amount is equal or greater than price")
  // Amount is equal or greater than price
  if (txInfo?.transaction["payment-transaction"].amount < 1000) {
    console.log("Amount is less than admin asset amount")
    res.status(400).send({
      success: false,
      message: "Amount is less than admin asset amount"
    })
    return;
  }

  console.log("inserting txId in database")
  // inserting txId in database
  let newTransactionModel = new transactionsModel({
    transactionId: req?.body?.txn?.txId,
  });
  newTransactionModel.save((err, data) => {
    if (!err) {
      console.log("Inserted in DB: ", data);
    } else {
      res.status(500).send({
        success: false,
        message: "Internal server error"
      });
      console.log("Internal server error: ", err);
      return;
    }
  });

  // inserting asset in assetsDetails model in database
  let newAssetDetailsModel = new assetsDetailsModel({
    assetId: req.body.assetId,
    owner: req.body.receiverAddr
  });
  newAssetDetailsModel.save((err, data) => {
    if (!err) {
      console.log("Inserted in DB: ", data);
    } else {
      res.status(500).send({
        success: false,
        message: "Internal server error"
      });
      console.log("Not inserted in database: ", err);
      return;
    }
  });

  try {
    const assetIndex = req.body.assetId; // identifying index of the asset

    params = await algodClient.getTransactionParams().do()

    // params.fee = 1000;
    // params.flatFee = true;

    sender = process.env.ESCROW_ADDRESS;
    recipient = req.body.receiverAddr;
    revocationTarget = undefined;
    closeRemainderTo = undefined;
    // Amount of the asset to transfer
    let amount = 1;

    // Trasnfer asset to buyer address
    let xtxn = algosdk.makeAssetTransferTxnWithSuggestedParams(
      sender,
      recipient,
      closeRemainderTo,
      revocationTarget,
      amount,
      new TextEncoder("utf-8").encode(req.body.note),
      assetIndex,
      params,
    );

    let escrowPrivateKey = algosdk.mnemonicToSecretKey(process.env.ESCROW_MNEMONIC);

    rawSignedTxn = xtxn.signTxn(escrowPrivateKey.sk)

    let xtx = (await algodClient.sendRawTransaction(rawSignedTxn).do());

    confirmedTxn = await algosdk.waitForConfirmation(algodClient, xtx.txId, 4);
    console.log("Transferring asset receiverAddr");
    console.log("Transaction " + xtx.txId + " confirmed in round " + confirmedTxn["confirmed-round"]);

    // deleting listing entry from database
    assetsModel
      .findOne({ assetId: +req.body.assetId })
      .exec(async (err, asset) => {
        if (!err) {
          // asset found
          // console.log("asset found: ", asset);

          if (asset) {
            let response = await assetsModel.deleteOne({ assetId: req.body.assetId });
            res.send({
              data: response,
              success: true,
              message: "successfully send asset to: " + req.body.receiverAddr,
              message2: "successfully deleted from db ",
              ...xtx,
              amount,
              assetId: assetIndex,
              confirmed_round: confirmedTxn["confirmed-round"]
            })
            return;

          } else {
            console.log("asset not found");
            res.status(400).send({
              success: false,
              message: "asset not found create first",
            });
            return;
          }
        } else {
          console.log("an error occured", err);
          res.status(500).send({
            message: "Internal server error"
          });
          return;
        }
      });
  }
  catch (err) {
    console.log("Error", err)
    res.status(500).send({
      success: false,
      message: err
    })
    return;
  }

})

app.get("/get-staking-details", (req, res, next) => {
  assetsDetailsModel
    .find({})
    .exec((err, asset) => {
      if (!err) {
        // Checking if asset exits or not
        if (asset) {
          res.send({
            success: true,
            data: asset
          })
        } else {
          res.status(400).send({
            success: false,
            message: "no records found",
          });
          console.log("no records found", asset);
          return;
        }
      } else {
        console.log(err);
        res.status(500).send({
          success: false,
          message: "Internal server error"
        });
        return;
      }
    });
  return;
})

app.get("/get-asset-data", (req, res, next) => {
  assetsModel
    .find({})
    .exec((err, asset) => {
      if (!err) {
        // Checking if asset exits or not
        if (asset) {
          res.send({
            success: true,
            data: asset
          })
        } else {
          res.status(400).send({
            success: false,
            message: "no records found",
          });
          console.log("no records found", asset);
          return;
        }
      } else {
        console.log(err);
        res.status(500).send({
          success: false,
          message: "Internal server error"
        });
        return;
      }
    });
  return;
})

app.post("/feature-my-asset", async (req, res, next) => {
  if (!req.body || !req.body.assetId || !req.body.txn) {
    res.status(400).send({
      success: false,
      message: "Incomplete data"
    })
    console.log("Incomplete data")
    return;
  }
  console.log("Req.body===>", req.body);

  const gettingAssetInfo = await assetsModel
  .findOne({ assetId: +req.body.assetId });

  console.log("wating for tx confirmation")
  const confirmedReqTxn = await algosdk.waitForConfirmation(algodClient, req.body.txn.txId, 4);
  console.log("Tx confirmed, Rounds: ", confirmedReqTxn["confirmed-round"])
  if (!confirmedReqTxn) {
    res.status(403).send({
      success: false,
      message: "Transaction not confirmed"
    })
  }

  // Checking id is already in database
  let transaction = await transactionsModel.findOne({ transactionId: req?.body?.txn?.txId })
  if (transaction) {
    res.status(400).send({
      message: "unauthorize request",
      success: false,
    })
    return;
  }

  // Admin address in To:
  const txInfo = await getTransactionInfoById(req?.body?.txn?.txId);
  if (txInfo?.transaction["payment-transaction"].receiver != process.env.ADMIN_ADDRESS) {
    res.status(400).send({
      success: false,
      message: "Transaction not to admin address"
    })
    return;
  }

  if(gettingAssetInfo?.owner !== txInfo?.transaction?.sender){
    res.status(400).send({
      success: false,
      message: "Owner address mismatch!"
    })
    return;
  }

  // Amount is equal or greater than price
  if (txInfo?.transaction["payment-transaction"].amount < 2000000) {
    res.status(400).send({
      success: false,
      message: "Amount is less than admin asset amount"
    })
    return;
  }

  assetsModel.findOneAndUpdate({ assetId: +req.body.assetId }, { isFeatured: true })
    .then((data) => {

      // Receiver address is not in sender of TX:
      if (txInfo?.transaction?.sender != data.owner) {
        res.status(400).send({
          success: false,
          message: "Transaction not to admin address"
        })
        return;
      }

      // inserting txId in database
      let newTransactionModel = new transactionsModel({
        transactionId: req?.body?.txn?.txId,
      });
      newTransactionModel.save((err, data) => {
        if (!err) {
          console.log("Inserted in DB: ", data);
        } else {
          res.status(500).send({
            success: false,
            message: "Internal server error"
          });
          console.log("Internal server error: ", err);
          return;
        }
      });

      console.log("successfully featured asset")
      res.send({
        data: data,
        success: true,
        message: "successfully featured asset",
      })
      return;
    })
    .catch(() => {
      console.log("Error in featuring asset");
      res.status(400).send({
        success: false,
        message: "Error in featuring asset",
      });
      return;
    })

})

app.post("/can-claim-reward", async (req, res, next) => {

  if (!req.body || !req.body.assetId || !req.body.receiverAddr) {
    res.status(400).send({
      success: false,
      message: "Incomplete data"
    })
    console.log("Incomplete data")
    return;
  }
  console.log("Req.body===>", req.body);

  // check if claiming in on by the admin
  let applicationInfoResponse = await algodClient.getApplicationByID(process.env.APPLICATION_ID).do();
  let globalState = applicationInfoResponse['params']['global-state']
  const canClaimGlobalState = globalState.filter((eachState) => eachState.key == "Y2FuQ2xhaW0=")[0]
  if (canClaimGlobalState?.value?.uint == 0) {
    console.log("can't claim")
    res.status(400).send({
      success: false,
      message: "Claiming reward is currently not on by the admin",
    });
    return;
  }

  const userAccountInformation = await algodClient.accountInformation(req.body.receiverAddr).do()
  const adminAccountInformation = await algodClient.accountInformation(process.env.ADMIN_ADDRESS).do()
  const contractInformation = await algodClient.accountInformation(process.env.APPLICATION_ADDRESS).do()

  const contractTokenDetails = contractInformation.assets.filter((eachAsset) => eachAsset["asset-id"] == process.env.TOKEN_ID)[0]

  const isUserHaveThisAsset = userAccountInformation?.assets.filter((eachAsset) => eachAsset["asset-id"] == req.body.assetId)[0]
  if (!isUserHaveThisAsset) {
    console.log("asset not found");
    res.status(400).send({
      success: false,
      message: "Asset not found in your wallet",
    });
    return;
  }

  // check this asset is of our marketplace
  const isAdminHaveThisAsset = adminAccountInformation?.assets.filter((eachAsset) => eachAsset["asset-id"] == req.body.assetId)[0]
  if (!isAdminHaveThisAsset) {
    console.log("asset not found");
    res.status(400).send({
      success: false,
      message: "Not asset of marketplace",
    });
    return;
  }
  console.log("isAdminHaveThisAsset", isAdminHaveThisAsset)

  const userAsset = await assetsDetailsModel.findOne({ assetId: req.body.assetId });
  if (!userAsset) {
    console.log("asset not found");
    res.status(400).send({
      success: false,
      message: "Asset not found",
    });
    return;
  }

  const differenceInMilliSeconds = new Date() - new Date(userAsset.lastClaimedAt)
  const differenceInDays = Math.floor(((differenceInMilliSeconds / 1000) / 3600) / 24)
  console.log("differenceInDays", differenceInDays);

  if (differenceInDays < 1) {
    console.log("One day not passed");
    res.status(400).send({
      success: false,
      message: "One day not passed",
    });
    return;
  }

  // check contract have enough tokens to send to this user
  if (contractTokenDetails.amount < differenceInDays) {
    console.log("contract have not enough xcolors");
    res.status(400).send({
      success: false,
      message: "Contract have insuffcient balance try again later",
    });
    return;
  }

  res.send({
    success: true,
    message: "can claim reward",
  });
  return;

})

app.post("/claim-reward", async (req, res, next) => {

  if (!req.body || !req.body.assetId || !req.body.receiverAddr || !req.body.txn) {
    res.status(400).send({
      success: false,
      message: "Incomplete data"
    })
    console.log("Incomplete data")
    return;
  }
  console.log("Req.body===>", req.body);

  const confirmedReqTxn = await algosdk.waitForConfirmation(algodClient, req.body.txn.txId, 4);
  console.log("Tx confirmed, Rounds: ", confirmedReqTxn["confirmed-round"])

  // Contract address in To:
  const txInfo = await getTransactionInfoById(req?.body?.txn?.txId);
  console.log("txInfo", txInfo)
  console.log("checking contract address in to")
  if (txInfo?.transaction["payment-transaction"].receiver != process.env.APPLICATION_ADDRESS) {
    console.log("Transaction not to contract address")
    res.status(400).send({
      success: false,
      message: "Transaction not to contract address"
    })
    return;
  }

  console.log("checking Receiver address is not in sender of TX")
  // Receiver address is not in sender of TX:
  if (txInfo?.transaction?.sender != req.body.receiverAddr) {
    console.log("Transaction not from receiver address address")
    res.status(400).send({
      success: false,
      message: "Transaction not from receiver address address"
    })
    return;
  }

  console.log("checking Amount is equal or greater than price")
  // Amount is equal or greater than price
  if (txInfo?.transaction["payment-transaction"].amount < 1000) {
    console.log("Amount is less than fee amount")
    res.status(400).send({
      success: false,
      message: "Amount is less than fee amount"
    })
    return;
  }

  const userAsset = await assetsDetailsModel.findOne({ assetId: req.body.assetId });
  if (!userAsset) {
    console.log("asset not found");
    res.status(400).send({
      success: false,
      message: "Asset not found",
    });
    return;
  }

  const differenceInMilliSeconds = new Date() - new Date(userAsset.lastClaimedAt)
  const differenceInDays = Math.floor(((differenceInMilliSeconds / 1000) / 3600) / 24)
  console.log("differenceInDays", differenceInDays);

  // if (differenceInDays < 1) {
  //   console.log("One day not passed");
  //   res.status(400).send({
  //     success: false,
  //     message: "One day not passed",
  //   });
  //   return;
  // }

  try {

    const appArgs = []
    appArgs.push(
      new Uint8Array(Buffer.from("claim")),
      // new Uint8Array(Buffer.from([(differenceInDays * 100)])),
      new Uint8Array(Buffer.from([+differenceInDays])),
    )
    let params = await algodClient.getTransactionParams().do()
    params.fee = 1000;
    params.flatFee = true;

    // create unsigned transaction
    let txn = algosdk.makeApplicationNoOpTxn(
      process.env.ADMIN_ADDRESS,
      params,
      +(process.env.APPLICATION_ID),
      appArgs,
      [req.body.receiverAddr],
      undefined,
      [+(process.env.TOKEN_ID)]
    )
    let adminPrivateKey = algosdk.mnemonicToSecretKey(process.env.ADMIN_MNEMONIC);

    let txId = txn.txID().toString();
    // Sign the transaction
    let signedTxn = txn.signTxn(adminPrivateKey.sk);
    console.log("Signed transaction with txID: %s", txId);

    // Submit the transaction
    await algodClient.sendRawTransaction(signedTxn).do()
    // Wait for transaction to be confirmed
    const confirmedTxn = await algosdk.waitForConfirmation(algodClient, txId, 4);
    console.log("confirmed" + confirmedTxn)

    //Get the completed Transaction
    console.log("Transaction " + txId + " confirmed in round " + confirmedTxn["confirmed-round"]);

    // display results
    let transactionResponse = await algodClient.pendingTransactionInformation(txId).do();
    console.log("Called app-id:", transactionResponse['txn']['txn']['apid'])
    if (transactionResponse['global-state-delta'] !== undefined) {
      console.log("Global State updated:", transactionResponse['global-state-delta']);
    }
    if (transactionResponse['local-state-delta'] !== undefined) {
      console.log("Local State updated:", transactionResponse['local-state-delta']);
    }

    assetsDetailsModel.updateOne({ assetId: req.body.assetId }, { lastClaimedAt: new Date().toISOString() })
      .then((data) => {
        console.log("Claimed successfully", data)
        res.send({
          success: true,
          message: "Successfully claimed",
          data
        });
        return;
      })
      .catch((error) => {
        console.log("Error", error)
        res.status(400).send({
          success: false,
          message: "Internal error",
        });
        return;
      })
  } catch (err) {
    console.log("Error", err)
    res.status(400).send({
      success: false,
      message: "Internal error",
    });
    return;
  }

  return;

})

app.get("/get-canvas-assets", async (req, res) => {
  const assets = await assetCanvasModel.find({});
  res.status(200).json(assets);
});

app.post("/buy-canvas-spot", async (req, res, next) => {
  if (!req.body || !req.body.assets || !req.body.txn || !req.body.receiverAddr) {
    res.status(400).send({
      success: false,
      message: "Incomplete data"
    })
    return;
  }
  
  const confirmedReqTxn = await algosdk.waitForConfirmation(algodClient, req.body.txn.txId, 4);
  console.log("Tx confirmed, Rounds: ", confirmedReqTxn["confirmed-round"])
  if (!confirmedReqTxn) {
    res.status(403).send({
      success: false,
      message: "Transaction not confirmed"
    })
  }

  // Checking id is already in database
  let transaction = await transactionsModel.findOne({ transactionId: req?.body?.txn?.txId })
  if (transaction) {
    res.status(400).send({
      message: "unauthorize request",
      success: false,
    })
    return;
  }

  const txInfo = await getTransactionInfoById(req?.body?.txn?.txId);
  
  // escrow address in To:
  if (txInfo?.transaction["asset-transfer-transaction"].receiver != process.env.ADMIN_ADDRESS) {
    console.log("Transaction not to escrow address")
    res.status(400).send({
      success: false,
      message: "Transaction not to escrow address"
    })
    return;
  }

  // sender of Tx and sender of this request is not same:
  if (txInfo?.transaction?.sender != req.body.receiverAddr) {
    console.log("Tx is not from this address")
    res.status(400).send({
      success: false,
      message: "Tx is not from this address"
    })
    return;
  }

  console.log("checking Amount is equal or greater than price");
  // Amount is equal or greater than price
  if (txInfo?.transaction["asset-transfer-transaction"].amount < req.body.assets.length) {
    console.log("Amount is less than admin asset amount")
    res.status(400).send({
      success: false,
      message: "Amount is less than admin asset amount"
    })
    return;
  }

  const asset_check = await getAssetInfoByAddress(req.body.receiverAddr);
  
  console.log("checking if asset is present in users assets");
  req.body.assets.map(asset => {
    if(asset_check.assets.filter(a => a['asset-id'] == asset.assetId).length === 0){
      res.status(400).send({
        success: false,
        message: `You don't asset #${asset.assetId}`
      });
      return;
    }
  })


  console.log("inserting txId in database")
  // inserting txId in database
  let newTransactionModel = new transactionsModel({
    transactionId: req?.body?.txn?.txId,
  });
  newTransactionModel.save((err, data) => {
    if (!err) {
      console.log("Inserted in DB");
    } else {
      res.status(500).send({
        success: false,
        message: "Internal server error"
      });
      console.log("Internal server error: ", err);
      return;
    }
  });


  let data = req.body.assets.map(a => ({
    assetId: a.assetId,
    owner: req.body.receiverAddr,
    name: a.assetName,
    position: a.canvasPosition
  }));
  
  assetCanvasModel.create(data, (err) => {
    if(!err){
      console.log("canvas saved");
    }else{
      res.status(500).send({
        success: false,
        message: "Internal server error"
      });
      console.log("Internal server error: ", err);
      return;
    }
  })

  return res.send({
    success: true,
    message: "Success",
  })
  

})

app.listen(PORT, () => {
  console.log(`Server is listening to port ${PORT}`)
})