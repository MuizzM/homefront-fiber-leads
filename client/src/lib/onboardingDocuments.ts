import { apiRequest } from "@/lib/queryClient";

export async function downloadOnboardingDocument(id: number, filename: string): Promise<void> {
  const response = await apiRequest("GET", `/api/onboarding/documents/${id}/download`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
