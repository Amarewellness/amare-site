type ActiveOneTimeCheckout = {
  sku: string;
  orderId: string;
};

let active: ActiveOneTimeCheckout | null = null;

export function setActiveOneTimeCheckout(next: ActiveOneTimeCheckout | null): void {
  active = next;
}

export function getActiveOneTimeCheckout(): ActiveOneTimeCheckout | null {
  return active;
}
