import { generateText, type LlmMessage } from './llm/index.ts';
import { db } from './storage.ts';

export async function handleProcurementChat(params: {
  message: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
}): Promise<{
  reply: string;
  suggestedActions: string[];
  referencedProducts: string[];
}> {
  const { message, history = [] } = params;

  const invoices = db.getInvoices();
  const masterProducts = db.getMasterProducts();
  const alerts = db.getAlerts();
  const stats = db.getStats();

  // Create a structured data context for the LLM provider
  const datasetContext = {
    summary: {
      totalInvoices: stats.totalInvoices,
      totalSpend: stats.totalSpend,
      activePriceAlerts: stats.activePriceAlerts,
      masterCatalogSize: masterProducts.length,
      topVendors: stats.topVendors,
    },
    masterProducts: masterProducts.map((p) => ({
      name: p.name,
      category: p.category,
      unit: p.standardUnit,
      currentPrice: p.currentPrice,
      previousPrice: p.previousPrice,
      minPrice: p.minPrice,
      maxPrice: p.maxPrice,
      lastPurchaseDate: p.lastPurchaseDate,
      knownVendors: p.vendorAliases.map((a) => `${a.vendorName} (alias: "${a.aliasName}")`),
      priceTrajectory: p.priceHistory.map((h) => `${h.date}: $${h.unitPrice} (${h.vendor})`),
    })),
    recentPriceAlerts: alerts.slice(0, 8).map((a) => ({
      product: a.productName,
      vendor: a.vendorName,
      date: a.invoiceDate,
      oldPrice: a.previousPrice,
      newPrice: a.newPrice,
      increasePct: `${a.percentChange}%`,
      status: a.status,
    })),
    recentInvoices: invoices.slice(0, 5).map((inv) => ({
      invoiceNumber: inv.invoiceNumber,
      vendor: inv.vendorName,
      date: inv.invoiceDate,
      total: inv.totalAmount,
      isScanned: inv.isScanned,
      itemCount: inv.items.length,
    })),
  };

  const systemInstruction = `
You are the Chief Procurement Analyst & Cost Forecasting Intelligence AI embedded in SpendPulse.
You have direct, real-time access to the user's persistent invoice database, master product catalog, vendor price histories, and price fluctuation alerts.

Your role:
1. Deliver sharp, quantitative answers citing exact historical prices, dates, vendors, and percentage variances from the provided database.
2. Formulate predictive forecasts for upcoming costs (e.g. 30-day, 60-day, or next quarter projections) by analyzing historical trajectories, vendor spread, and commodity trends.
3. Recommend tactical procurement decisions: renegotiation opportunities, vendor consolidation, or switching suppliers based on historical price dispersion.
4. Format responses cleanly using clean Markdown formatting (bullet points, bold highlights, concise data tables when helpful). Avoid generic fluff.
5. In addition to your detailed analysis, suggest 2-3 quick follow-up prompt questions or tactical actions the user can take.
`;

  const messages: LlmMessage[] = [
    { role: 'system', parts: [{ type: 'text', text: systemInstruction }] },
  ];

  // Add conversation history
  for (const turn of history.slice(-6)) {
    messages.push({
      role: turn.role === 'assistant' ? 'assistant' : 'user',
      parts: [{ type: 'text', text: turn.content }],
    });
  }

  // Add current query with fresh dataset context
  messages.push({
    role: 'user',
    parts: [
      {
        type: 'text',
        text: `
[CURRENT PROCUREMENT DATABASE CONTEXT]
${JSON.stringify(datasetContext, null, 2)}
[/CURRENT PROCUREMENT DATABASE CONTEXT]

User Request: "${message}"

Please analyze the data and provide:
1. Direct findings and historical trend analysis.
2. Cost expectation / forecast for future periods based on recent trends.
3. Specific actionable recommendations for cost mitigation.
`,
      },
    ],
  });

  try {
    const raw = await generateText({
      messages,
      modelKind: 'text',
      temperature: 0.7,
      maxOutputTokens: 4096,
    });

    const reply =
      raw?.trim() ||
      "I've analyzed the purchasing data. Please ask a specific question regarding vendor trends or product costs.";

    // Extract product references
    const referencedProducts: string[] = [];
    masterProducts.forEach((p) => {
      if (reply.toLowerCase().includes(p.name.toLowerCase())) {
        referencedProducts.push(p.name);
      }
    });

    // Provide relevant quick actions
    const suggestedActions = [
      'Show 90-day cost projection for dairy & baking',
      'Compare Sysco vs US Foods price creep',
      'List all unacknowledged price alerts',
    ];

    return {
      reply,
      suggestedActions,
      referencedProducts,
    };
  } catch (err) {
    console.error('AI chat error:', err);
    const topAlerts = db.getAlerts().filter((a) => a.status === 'active').slice(0, 3);
    const alertSummary = topAlerts.length
      ? topAlerts.map((a) => `${a.productName} (+${a.percentChange}%) from ${a.vendorName}`).join(', ')
      : 'no active price alerts';
    return {
      reply: `The AI analysis engine is temporarily unavailable. Based on your local data, you currently have active price increase alerts on: ${alertSummary}. Review the Price Alerts tab for details.`,
      suggestedActions: [
        'Review active price alerts',
        'Show 90-day cost projection',
        'Compare vendor price creep',
      ],
      referencedProducts: topAlerts.map((a) => a.productName),
    };
  }
}
