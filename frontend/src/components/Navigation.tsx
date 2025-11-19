import Image from "next/image";
import Link from "next/link";
import { useNearWallet } from "@/hooks/useNearWallet";
import { KeyPair } from "@near-js/crypto";
import NearLogo from "/public/near-logo.svg";

interface StoredKeyData {
  accountId: string;
  publicKey: string;
  privateKey: string;
  contractId: string;
  allowedMethods: string[];
}

export const Navigation = () => {
  const { signedAccountId, loading, signIn, signOut, wallet, provider } = useNearWallet();

  const handleAction = () => {
    if (signedAccountId) {
      signOut();
    } else {
      signIn();
    }
  };

  const handleAddKey = async () => {
    if (!wallet || !signedAccountId) {
      alert("No wallet connected. Please sign in first.");
      return;
    }

    const contractId = "guestbook.near-examples.testnet";
    const allowedMethods = ["add_message"];
    const allowance = "250000000000000000000000";
    const STORAGE_KEY = `access_key_${contractId}`;

    console.log("[AddAccessKey] Creating function access key for:", {
      contractId,
      methods: allowedMethods,
      accountId: signedAccountId,
    });

    // Generate new key pair using modern API
    const keyPair = KeyPair.fromRandom("ed25519");
    const publicKey = keyPair.getPublicKey().toString();
    const privateKey = keyPair.toString();

    try {
      console.log("[AddAccessKey] Adding access key to account on-chain...", {
        accountId: signedAccountId,
        publicKey,
        contractId,
        allowance,
        methodNames: allowedMethods,
      });

      const addKeyAction = {
        type: "AddKey" as const,
        params: {
          publicKey,
          accessKey: {
            permission: {
              receiverId: contractId,
              allowance,
              methodNames: allowedMethods,
            },
          },
        },
      };

      console.log("[AddAccessKey] Action being sent:", JSON.stringify(addKeyAction, null, 2));

      const outcome = await wallet.signAndSendTransaction({
        signerId: signedAccountId,
        receiverId: signedAccountId,
        actions: [addKeyAction],
        network: "testnet",
      });

      console.log("[AddAccessKey] Transaction outcome:", outcome);

      // Verify the transaction was successful
      if (outcome && (outcome as any).status &&
          (typeof (outcome as any).status === 'object' && 'SuccessValue' in (outcome as any).status ||
           typeof (outcome as any).status === 'object' && 'SuccessReceiptId' in (outcome as any).status)) {

        console.log("[AddAccessKey] Transaction successful, waiting for key to be available...");

        // Wait for the key to be available on-chain before saving it
        // Try up to 10 times with 1 second delay
        let keyAvailable = false;
        for (let attempt = 0; attempt < 10; attempt++) {
          try {
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second

            const keyInfo: any = await provider.query({
              request_type: "view_access_key",
              account_id: signedAccountId,
              public_key: publicKey,
              finality: "final",
            });

            console.log(`[AddAccessKey] Key found on-chain (attempt ${attempt + 1}):`, keyInfo);
            keyAvailable = true;
            break;
          } catch (error) {
            console.log(`[AddAccessKey] Key not yet available (attempt ${attempt + 1})`);
          }
        }

        if (!keyAvailable) {
          console.warn("[AddAccessKey] Key created but not yet visible on-chain, saving anyway");
        }

        // Store the key pair for later use
        const keyData: StoredKeyData = {
          accountId: signedAccountId,
          publicKey,
          privateKey,
          contractId,
          allowedMethods,
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(keyData));

        console.log("[AddAccessKey] Access key created on-chain and stored locally");
        alert("Access key added successfully! You can now send messages without wallet confirmation.");
      } else {
        throw new Error("Transaction did not complete successfully");
      }
    } catch (error) {
      console.error("[AddAccessKey] Failed to create access key:", error);
      alert(`Failed to create access key: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const label = loading
    ? "Loading..."
    : signedAccountId
    ? `Logout ${signedAccountId}`
    : "Login";

  return (
    <nav className="navbar navbar-expand-lg">
      <div className="container-fluid">
        <Link href="/">
          <Image
            priority
            src={NearLogo}
            alt="NEAR"
            width="30"
            height="24"
            className="d-inline-block align-text-top"
          />
        </Link>
        <div className="navbar-nav pt-1 d-flex gap-2">
          {signedAccountId && (
            <button className="btn btn-primary" onClick={handleAddKey}>
              Add Key
            </button>
          )}
          <button className="btn btn-secondary" onClick={handleAction}>
            {label}
          </button>
        </div>
      </div>
    </nav>
  );
};
