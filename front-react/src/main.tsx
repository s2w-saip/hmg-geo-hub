import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { queryClient } from "~/api/query-client";
import { App } from "~/app/app";
import "./legacy/app/globals.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<StrictMode><QueryClientProvider client={queryClient}><BrowserRouter><App /><Toaster position="bottom-center" /></BrowserRouter></QueryClientProvider></StrictMode>);
