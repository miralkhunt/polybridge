import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { Wallet } from "ethers"; // v5.8.0
import dotenv from "dotenv";
dotenv.config();

const signer = new Wallet(process.env.WALLET_PRIVATE_KEY);

const tempClient = new ClobClient("https://clob.polymarket.com", 137, signer);
const apiCreds = await tempClient.createOrDeriveApiKey();
const client = new ClobClient(
  "https://clob.polymarket.com",
  137,
  signer,
  apiCreds,
  2,
  process.env.POLY_ADDRESS,
);

// const response = await client.createAndPostOrder(
//     {
//       tokenID: "12995581063379840470706034292258461549917004937479335435444839663340844344333",
//       price: 0.01,
//       size: 10,
//       side: Side.BUY,
//     },
//     {
//       tickSize: "0.01",
//       negRisk: false, // Set to true for multi-outcome markets
//     },
//     OrderType.FOK,
//   );


const response = await client.createAndPostMarketOrder(
  {
    tokenID: "38587100917177148286748239437507914031065378811839010691755690299161546290305",
    side: Side.BUY,
    amount: 0.001,
    price: 0.5,
  },
  { tickSize: "0.01", negRisk: false },
  OrderType.FOK,
);

console.log("Response: ", response);