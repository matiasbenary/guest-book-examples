import "@/styles/globals.css";

import type { AppProps } from "next/app";
import { Navigation } from "@/components/Navigation";
import { NearProvider } from "@/hooks/useNearWallet";

export default function App({ Component, pageProps }: AppProps) {
  return (
    <NearProvider
      network="testnet"
      contractId="guestbook.near-examples.testnet"
      allowedMethods={["add_message"]}
    >
      <Navigation />
      <Component {...pageProps} />
    </NearProvider>
  );
}
