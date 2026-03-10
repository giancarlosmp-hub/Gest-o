import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import App from "./App";
import "./index.css";
import { Toaster } from "sonner";


if (import.meta.env.PROD) {
  console.debug = () => undefined;
  console.info = () => undefined;
  console.log = () => undefined;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
        <Toaster richColors />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
