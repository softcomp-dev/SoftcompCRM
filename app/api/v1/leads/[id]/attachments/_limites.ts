/**
 * Os limites do anexo do negócio — UM par de números para a tela (sessão) e
 * para o ERP (Bearer). Um teto por porta seria o ERP anexando o que a tela
 * recusa, ou o contrário.
 */
export const BUCKET_DE_ANEXO = "internal-media";
export const TAMANHO_MAXIMO_DO_ANEXO = 50 * 1024 * 1024; // 50 MB

export const MIMES_DO_ANEXO = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/jpg",
]);
