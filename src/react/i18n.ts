/**
 * Minimal i18n for `cosmos-providers/react`'s screens — English, Spanish and
 * Portuguese. Every screen takes an optional `locale?: Locale` prop
 * (default `"en"`) and looks its built-in copy up here; text you pass
 * explicitly via props (amounts, names, labels you supply) is never
 * translated — only the component's own fixed microcopy is.
 */

export type Locale = "en" | "es" | "pt";

const en = {
  // AddCardForm
  addCardTitle: "Add Card",
  addCardHolderDefault: "Card holder",
  addCardHeading: "Credit Card Info",
  addCardHolderName: "Card Holder Name",
  addCardNumber: "Card number*",
  addCardExpiry: "Expiry Date MM/YY*",
  addCardCvv: "CVV",
  addCardSave: "Save",
  back: "Back",

  // TransactionDetails
  transactionDetails: "Transaction details",
  totalPaid: "Total Paid",
  cardHolder: "Card holder",
  backToHome: "Back to Home",
  download: "Download",
  onlinePayment: "Online Payment",
  category: "Category",
  orderNumberLabel: "Order Number",

  // OrderThankYou
  thankYou: "Thank you, {name}!",
  orderProcessed: "Your order has been processed successfully!",
  orderDetails: "Order details",
  numberOrder: "Number order",
  orderDate: "Order date",
  totalItems: "Total items",
  details: "Details",
  price: "Price",
  shipping: "Shipping",
  free: "FREE",
  totalPrice: "Total Price",
  supportNote: "Note: if you need help please contact customer service",

  // PaymentConfirmation
  paymentSuccess: "Payment Success!",
  paymentDoneMessage: "Your payment has been successfully done",
  share: "Share",
  print: "Print",

  // PaymentForm
  order: "Order",
  time: "Time",
  coachName: "Coach name",
  sessionPrice: "Session price",
  cardDetails: "Card details",
  cardNumberLabel: "Card Number",
  expDate: "Exp. Date",
  cvv: "CVV",

  // PaymentSuccess
  paymentSuccessful: "Payment Successful",
  totalPayment: "Total Payment",
  paymentMethod: "Payment Method",
  status: "Status",
  success: "Success",
  date: "Date",
  paymentTotal: "Payment Total",
  done: "Done",

  // CheckoutPage
  selectPaymentOption: "Select Payment Option",
  secureTransactions: "All transactions are secure and encrypted",
  cancelBooking: "Cancel Booking",
  yourCart: "Your cart",
  orderSummary: "Order summary",
  termsNotice: "By continuing, I agree to the Terms & Conditions and Privacy Policy",

  // ConfirmSend
  confirmSend: "Confirm Send",
  walletAddress: "Wallet address",
  network: "Network",
  transactionFee: "Transaction fee",
  freeFee: "Free $0.00",
  sendRole: "Send",
  receiveRole: "Receive",
  fromYou: "From you",
  toPrefix: "To",

  // SelectWithdrawMethod
  selectMethod: "Select Method",
  cashPayment: "Cash Payment",
  cryptoPayment: "Crypto Payment",

  // SendSuccessful
  sendSuccessful: "Send Successful",
  sendSuccessMessage: "Your payment has been sent successfully and the transaction is now complete.",

  // ReceivePayment
  scanToPay: "Scan to pay",
  continueFromPhone: "Continue from your phone",
  openPaymentLink: "Open payment link",
  /** Shown on the payment-link button once it has been opened, while the checkout is still outstanding. */
  paymentLinkOpened: "Payment in process…",
  copyCode: "Copy code",
};

const es: Record<keyof typeof en, string> = {
  addCardTitle: "Agregar tarjeta",
  addCardHolderDefault: "Titular de la tarjeta",
  addCardHeading: "Información de la tarjeta",
  addCardHolderName: "Nombre del titular",
  addCardNumber: "Número de tarjeta*",
  addCardExpiry: "Fecha de vencimiento MM/AA*",
  addCardCvv: "CVV",
  addCardSave: "Guardar",
  back: "Atrás",

  transactionDetails: "Detalles de la transacción",
  totalPaid: "Total pagado",
  cardHolder: "Titular de la tarjeta",
  backToHome: "Volver al inicio",
  download: "Descargar",
  onlinePayment: "Pago en línea",
  category: "Categoría",
  orderNumberLabel: "Número de orden",

  thankYou: "¡Gracias, {name}!",
  orderProcessed: "¡Tu pedido fue procesado con éxito!",
  orderDetails: "Detalles del pedido",
  numberOrder: "Número de pedido",
  orderDate: "Fecha del pedido",
  totalItems: "Total de artículos",
  details: "Detalles",
  price: "Precio",
  shipping: "Envío",
  free: "GRATIS",
  totalPrice: "Precio total",
  supportNote: "Nota: si necesitás ayuda, contactá a atención al cliente",

  paymentSuccess: "¡Pago exitoso!",
  paymentDoneMessage: "Tu pago se realizó correctamente",
  share: "Compartir",
  print: "Imprimir",

  order: "Pedido",
  time: "Hora",
  coachName: "Nombre del entrenador",
  sessionPrice: "Precio de la sesión",
  cardDetails: "Datos de la tarjeta",
  cardNumberLabel: "Número de tarjeta",
  expDate: "Vencimiento",
  cvv: "CVV",

  paymentSuccessful: "Pago exitoso",
  totalPayment: "Pago total",
  paymentMethod: "Método de pago",
  status: "Estado",
  success: "Exitoso",
  date: "Fecha",
  paymentTotal: "Total pagado",
  done: "Listo",

  selectPaymentOption: "Elegí el método de pago",
  secureTransactions: "Todas las transacciones son seguras y encriptadas",
  cancelBooking: "Cancelar reserva",
  yourCart: "Tu carrito",
  orderSummary: "Resumen del pedido",
  termsNotice: "Al continuar, aceptás los Términos y Condiciones y la Política de Privacidad",

  confirmSend: "Confirmar envío",
  walletAddress: "Dirección de billetera",
  network: "Red",
  transactionFee: "Comisión de transacción",
  freeFee: "Gratis $0.00",
  sendRole: "Enviás",
  receiveRole: "Recibe",
  fromYou: "De vos",
  toPrefix: "A",

  selectMethod: "Elegir método",
  cashPayment: "Pago en efectivo",
  cryptoPayment: "Pago en cripto",

  sendSuccessful: "Envío exitoso",
  sendSuccessMessage: "Tu pago se envió correctamente y la transacción ya está completa.",

  scanToPay: "Escaneá para pagar",
  continueFromPhone: "Continuá desde tu teléfono",
  openPaymentLink: "Abrir link de pago",
  paymentLinkOpened: "Pago en proceso…",
  copyCode: "Copiar código",
};

const pt: Record<keyof typeof en, string> = {
  addCardTitle: "Adicionar cartão",
  addCardHolderDefault: "Titular do cartão",
  addCardHeading: "Informações do cartão",
  addCardHolderName: "Nome do titular",
  addCardNumber: "Número do cartão*",
  addCardExpiry: "Validade MM/AA*",
  addCardCvv: "CVV",
  addCardSave: "Salvar",
  back: "Voltar",

  transactionDetails: "Detalhes da transação",
  totalPaid: "Total pago",
  cardHolder: "Titular do cartão",
  backToHome: "Voltar ao início",
  download: "Baixar",
  onlinePayment: "Pagamento online",
  category: "Categoria",
  orderNumberLabel: "Número do pedido",

  thankYou: "Obrigado, {name}!",
  orderProcessed: "Seu pedido foi processado com sucesso!",
  orderDetails: "Detalhes do pedido",
  numberOrder: "Número do pedido",
  orderDate: "Data do pedido",
  totalItems: "Total de itens",
  details: "Detalhes",
  price: "Preço",
  shipping: "Frete",
  free: "GRÁTIS",
  totalPrice: "Preço total",
  supportNote: "Nota: se precisar de ajuda, entre em contato com o atendimento",

  paymentSuccess: "Pagamento realizado!",
  paymentDoneMessage: "Seu pagamento foi concluído com sucesso",
  share: "Compartilhar",
  print: "Imprimir",

  order: "Pedido",
  time: "Horário",
  coachName: "Nome do treinador",
  sessionPrice: "Preço da sessão",
  cardDetails: "Dados do cartão",
  cardNumberLabel: "Número do cartão",
  expDate: "Validade",
  cvv: "CVV",

  paymentSuccessful: "Pagamento aprovado",
  totalPayment: "Pagamento total",
  paymentMethod: "Forma de pagamento",
  status: "Status",
  success: "Aprovado",
  date: "Data",
  paymentTotal: "Total pago",
  done: "Concluído",

  selectPaymentOption: "Selecione a forma de pagamento",
  secureTransactions: "Todas as transações são seguras e criptografadas",
  cancelBooking: "Cancelar reserva",
  yourCart: "Seu carrinho",
  orderSummary: "Resumo do pedido",
  termsNotice: "Ao continuar, você concorda com os Termos e Condições e a Política de Privacidade",

  confirmSend: "Confirmar envio",
  walletAddress: "Endereço da carteira",
  network: "Rede",
  transactionFee: "Taxa de transação",
  freeFee: "Grátis $0,00",
  sendRole: "Envia",
  receiveRole: "Recebe",
  fromYou: "De você",
  toPrefix: "Para",

  selectMethod: "Selecionar método",
  cashPayment: "Pagamento em dinheiro",
  cryptoPayment: "Pagamento em cripto",

  sendSuccessful: "Envio concluído",
  sendSuccessMessage: "Seu pagamento foi enviado com sucesso e a transação já está completa.",

  scanToPay: "Escaneie para pagar",
  continueFromPhone: "Continue pelo seu celular",
  openPaymentLink: "Abrir link de pagamento",
  paymentLinkOpened: "Pagamento em andamento…",
  copyCode: "Copiar código",
};

export const DICTIONARIES = { en, es, pt } satisfies Record<Locale, Record<string, string>>;

export type TranslationKey = keyof typeof en;

/** Looks up `key` in `locale`'s dictionary (falling back to English), interpolating `{var}` placeholders from `vars`. */
export function t(locale: Locale | undefined, key: TranslationKey, vars?: Record<string, string>): string {
  let str = DICTIONARIES[locale ?? "en"][key] ?? DICTIONARIES.en[key];
  if (vars) {
    for (const [k, v] of Object.entries(vars)) str = str.replace(`{${k}}`, v);
  }
  return str;
}
