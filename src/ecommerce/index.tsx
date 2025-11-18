import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App, type PizzazShopAppProps } from "../pizzaz-shop/app";

export type EcommerceAppProps = PizzazShopAppProps;

const container = document.getElementById("ecommerce-root");

if (!container) {
  throw new Error("Missing root element: ecommerce-root");
}

createRoot(container).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
);

export default App;
