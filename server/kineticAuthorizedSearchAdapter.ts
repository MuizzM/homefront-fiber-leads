import {
  getAuthToken,
  ProviderAccessDeniedError,
  scanAddress,
} from "./scanner";
import {
  hashKineticEvidence,
  type KineticEvidenceResponse,
  type KineticEvidenceSourceAdapter,
  type KineticPostalAddress,
  type NormalizedKineticAddress,
} from "./kineticProviderAdapter";
import { isActiveBilling } from "@shared/billingStatus";

const PARSER_VERSION = "authorized-address-search-v1";

/**
 * Bridges the existing token -> address-search scanner into the Kinetic command
 * center. It does not create another scheduler: scanAddress() always enters the
 * same process-wide provider queue used by manual, lasso, city, and market work.
 */
export class KineticAuthorizedSearchAdapter implements KineticEvidenceSourceAdapter {
  readonly id = "kinetic_authorized_address_search";
  readonly mode = "approved_api" as const;
  readonly contractVersion = "token-get+address-search-v1";

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; message: string }> {
    const started = Date.now();
    try {
      await getAuthToken();
      return { ok: true, latencyMs: Date.now() - started, message: "Authorized token session ready" };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, message: String((error as any)?.message ?? error) };
    }
  }

  async qualifyAddress(address: KineticPostalAddress): Promise<KineticEvidenceResponse> {
    try {
      const result = await scanAddress(address.address, address.city, address.state, address.zip, { source: "coming_soon" });
      if (result.apiSource === "failed") {
        return { outcome: "error", record: null, message: result.notes };
      }
      const observedAt = new Date().toISOString();
      const raw = result.rawResponse ?? result;
      const responseHash = hashKineticEvidence(raw);
      const record: NormalizedKineticAddress = {
        kineticAddressId: result.dfAddressId,
        sequentialId: null,
        address: result.address,
        city: result.city,
        state: result.state,
        zip: result.zip,
        latitude: result.lat,
        longitude: result.lng,
        exchangeId: result.exchangeId,
        technologyType: result.techType,
        maximumQualification: result.maxDownloadMbps,
        estimatedCompletionDate: null,
        isLive: result.fiberAvailable,
        isComingSoon: result.isNewFiber
          ? isActiveBilling(result.billingStatus)
          : null,
        isCopperUpgradeCandidate: null,
        billingStatus: result.billingStatus,
        householdSegmentType: result.householdSegmentType,
        fiberStatus: result.fiberStatus,
        isNewFiber: result.isNewFiber,
        evidenceMode: "approved_api",
        evidenceSource: this.id,
        evidenceId: responseHash,
        observedAt,
        parserVersion: PARSER_VERSION,
        rawResponse: raw,
        responseHash,
      };
      return { outcome: result.fiberStatus === "no_service" ? "not_found" : "ok", record };
    } catch (error) {
      if (error instanceof ProviderAccessDeniedError) {
        return { outcome: "denied", record: null, statusCode: 403, message: error.message };
      }
      return { outcome: "error", record: null, message: String((error as any)?.message ?? error) };
    }
  }
}
