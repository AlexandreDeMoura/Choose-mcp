export const LIVE_SALES_ENDPOINT = "https://api.appchoose.io/app/sales/live";

export type Sale = {
  id: string;
  name: string;
  imageUrl: string;
  categories: string[];
};

export type SalesToolResult = {
  generatedAt: string;
  count: number;
  sales: Sale[];
};

const TARGET_CARD_IMAGE_WIDTH = "400";
const TARGET_CARD_IMAGE_HEIGHT = "200";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function toCardImageUrl(rawUrl: string | null): string {
  if (!rawUrl) {
    return "";
  }

  return rawUrl
    .replaceAll("[W]", TARGET_CARD_IMAGE_WIDTH)
    .replaceAll("[H]", TARGET_CARD_IMAGE_HEIGHT);
}

function toCategoryList(rawValue: unknown): string[] {
  if (!Array.isArray(rawValue)) {
    return [];
  }

  return rawValue
    .map(readString)
    .filter((category): category is string => category !== null);
}

export function normalizeSales(payload: unknown): Sale[] {
  const response = asRecord(payload);
  const rawSales = response?.sales;

  if (!Array.isArray(rawSales)) {
    return [];
  }

  return rawSales.flatMap((rawSale, index) => {
    const sale = asRecord(rawSale);
    if (!sale) {
      return [];
    }

    const name = readString(sale.name) ?? "Unknown Sale";
    const rawId = readString(sale.id);
    const id = rawId ?? `${slugify(name) || "sale"}-${index + 1}`;
    const imageUrl = toCardImageUrl(readString(sale.image_header));
    const categories = toCategoryList(sale.categories);

    return [{ id, name, imageUrl, categories }];
  });
}

export function buildSalesToolResult(payload: unknown): SalesToolResult {
  const generatedAt = new Date().toISOString();
  const sales = normalizeSales(payload);

  return {
    generatedAt,
    count: sales.length,
    sales,
  };
}

export function parseSalesToolResult(payload: unknown): SalesToolResult | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }

  const generatedAt = readString(record.generatedAt);
  if (!generatedAt) {
    return null;
  }

  const sales = normalizeSales({ sales: record.sales });
  const rawCount = record.count;
  const parsedCount =
    typeof rawCount === "number" && Number.isFinite(rawCount)
      ? rawCount
      : sales.length;

  return {
    generatedAt,
    count: parsedCount,
    sales,
  };
}

export function createSalesSummaryText(result: SalesToolResult): string {
  if (result.count === 0) {
    return "No live sales are available right now.";
  }

  const label = result.count === 1 ? "sale" : "sales";
  return `Fetched ${result.count} live ${label} from Choose.`;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
