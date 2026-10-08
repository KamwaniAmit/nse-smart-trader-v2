// Prices are quoted to 2 decimals. All arithmetic is done in integer paise so that sums and P&L carry no
// floating-point drift (for example 69.8 + 50.95 is exactly 120.75).

export const toPaise = (rupees: number): number => Math.round(rupees * 100);
export const fromPaise = (paise: number): number => paise / 100;
export const round4 = (n: number): number => Math.round(n * 10000) / 10000;
