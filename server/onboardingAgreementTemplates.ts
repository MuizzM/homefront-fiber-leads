import {
  ONBOARDING_DOCUMENT_META,
  type AgreementSection,
  type AgreementSnapshot,
  type OnboardingDocumentType,
} from "../shared/onboardingDocuments";

// ─────────────────────────────────────────────────────────────────────────────
// ⚠️  INTERNAL LEGAL-REVIEW NOTE — NOT signer-facing. Do not remove.
// The Commission Agreement below (reserve mechanics, classification, offset,
// release, and liability language) is a good-faith draft. It MUST be reviewed
// and approved by qualified North Carolina counsel before production use, and
// re-checked for NC wage-payment, independent-contractor-classification, and
// consumer-protection requirements. This code comment is the conspicuous
// internal notice; it is intentionally absent from the rendered agreement the
// contractor signs.
// ─────────────────────────────────────────────────────────────────────────────

// Bumped from 2026.07.1: the Commission Agreement changed materially (10%
// chargeback reserve, representative-capacity signature, expanded validation
// grounds). A version bump re-triggers acceptance for every rep — the system's
// "sign the current version" gate is how material-term changes get re-consented.
export const AGREEMENT_VERSION = "2026.08.1";

// The Company's legal identity, stated once. Sections use "the Company"
// thereafter, per the requirement to minimize use of the full legal name.
const COMPANY_LEGAL_NAME = "HomeFront Solutions LLC";
const COMPANY_ADDRESS = "605 Abbie Ave, High Point, NC 27263";
const CHARGEBACK_RESERVE_PERCENT = 10;
const RESERVE_RELEASE_DAYS = 90;

interface TemplateContext {
  companyName: string;
  signerName: string;
  signerEmail: string;
  issuedAt: string;
}

function contractorSections({ companyName }: TemplateContext): AgreementSection[] {
  return [
    {
      heading: "1. Engagement",
      paragraphs: [
        `${companyName} (the “Company”) engages the signer (the “Contractor”) to identify prospective customers, explain authorized fiber-service offers, and submit accurate orders and field activity through Company systems. Contractor accepts this engagement subject to this Agreement and the Company’s written compliance and safety policies.`,
      ],
    },
    {
      heading: "2. Independent contractor relationship",
      paragraphs: [
        "Contractor is an independent contractor and not an employee, partner, joint venturer, or agent with authority to bind the Company or any service provider. Contractor controls the manner, means, sequence, and schedule of the work, subject to applicable law, customer consent, territory restrictions, service-provider requirements, and the Company’s compliance standards.",
        "Contractor is responsible for all federal, state, and local taxes, licenses, permits, insurance, transportation, equipment, and ordinary expenses arising from the work unless the Company agrees otherwise in a signed writing. No wages, overtime, benefits, paid leave, unemployment benefits, or workers’ compensation coverage are promised by this Agreement.",
      ],
    },
    {
      heading: "3. Standards and authority",
      paragraphs: [
        "Contractor will identify themself accurately, use only approved offers and materials, protect customer information, follow all solicitation, privacy, consumer-protection, and trespass laws, and never misrepresent service availability, price, affiliation, installation timing, or savings. Contractor may not collect customer money unless expressly authorized in writing.",
      ],
    },
    {
      heading: "4. Records and cooperation",
      paragraphs: [
        "Contractor will enter complete and truthful lead, visit, consent, and sale information promptly. Contractor will cooperate with reasonable investigations of complaints, chargebacks, safety incidents, fraud, or regulatory inquiries and will return Company property and credentials when the engagement ends.",
      ],
    },
    {
      heading: "5. Term and termination",
      paragraphs: [
        "Either party may end the engagement at any time by written or electronic notice, subject to payment of commissions that have been earned under the applicable Commission Agreement. Sections concerning confidentiality, data protection, records, payment adjustments, and responsibility for prior conduct survive termination.",
      ],
    },
    {
      heading: "6. Entire agreement",
      paragraphs: [
        "This Agreement, the Commission Agreement, Confidentiality & Data Security Agreement, Field Safety & Conduct Agreement, and incorporated written policies form the parties’ agreement about the engagement. Any amendment must be recorded in a later writing or electronic record accepted by both parties. If a provision is unenforceable, the remaining provisions continue to apply.",
      ],
    },
  ];
}

function commissionSections(_ctx: TemplateContext): AgreementSection[] {
  return [
    {
      heading: "1. Parties and commission plan",
      paragraphs: [
        `This Commission Agreement is between ${COMPANY_LEGAL_NAME}, ${COMPANY_ADDRESS} (the “Company”), and the signer (the “Contractor”). The Company will compensate the Contractor under the commission structure assigned to the Contractor in the Home Front portal. The portal’s effective-dated rate, tier ladder, qualification rule, carrier, territory, and commission statement are incorporated into this Agreement.`,
        "The Company may change the commission structure prospectively by a new written or electronic notice with an effective date. A commission already earned under a prior effective-dated structure will not be reduced solely because the structure changes afterward.",
      ],
    },
    {
      heading: "2. When a commission is earned",
      paragraphs: [
        "A commission is earned only when the order is attributed to the Contractor, contains accurate customer and service information, satisfies the active qualification rule shown in the portal, and clears validation. A submitted order or a customer’s verbal commitment alone is not an earned commission.",
        "Commissions remain subject to validation, cancellation, nonpayment, fraud, duplicate orders, installation requirements, customer eligibility, carrier or service-provider rejection, reversals, and chargebacks. If any of these conditions applies before or after payment, the affected commission is not earned and any amount already paid for it may be reversed or offset as described below.",
      ],
    },
    {
      heading: "3. Statements and payment",
      paragraphs: [
        "The Company will make commission statements available through the portal and pay finalized, undisputed balances, net of the chargeback reserve in Section 4, according to the published payout schedule. Each statement itemizes qualified sales, the applied rate or tier, adjustments, the reserve amount withheld or released, and the net payable.",
        "Contractor must review each statement and report a specific dispute within 30 calendar days after it becomes available. The Company will investigate documented disputes in good faith and correct confirmed errors.",
      ],
    },
    {
      heading: "4. Chargeback reserve",
      paragraphs: [
        `The Company will withhold ${CHARGEBACK_RESERVE_PERCENT}% of otherwise payable commissions as a chargeback reserve. The remaining ${100 - CHARGEBACK_RESERVE_PERCENT}% is paid on the normal payout schedule. The reserve secures the Company against later chargebacks, reversals, and related amounts described in this Agreement.`,
        `The reserve is calculated per pay period as ${CHARGEBACK_RESERVE_PERCENT}% of the Contractor’s otherwise payable commissions for that period, tracked as a running balance. Each contribution to, draw against, and release from the reserve is shown on the Contractor’s commission statements in the portal, so the balance can be reconciled against the underlying sales.`,
        "Valid chargebacks, reversals, offsets, debts owed to the Company, overpayments, and other deductions permitted by this Agreement and applicable law are drawn first against the reserve balance and are reflected on the statement that records them.",
        `Following termination of the engagement for any reason, the Company will pay any remaining reserve balance to the Contractor within ${RESERVE_RELEASE_DAYS} days after the effective termination date, less valid chargebacks, reversals, offsets, debts, overpayments, or other deductions permitted by this Agreement and applicable law. If permitted deductions exceed the reserve balance, the excess remains payable by the Contractor only to the extent applicable law allows. No deduction or offset will reduce compensation below any limit imposed by applicable law.`,
      ],
    },
    {
      heading: "5. Adjustments",
      paragraphs: [
        "The Company may reverse or offset an amount that was paid for a cancelled, duplicated, fraudulent, provider-rejected, customer-rescinded, or otherwise unqualified order. Each adjustment appears on a commission statement identifying the related sale or the reason, so it can be reconciled.",
      ],
    },
    {
      heading: "6. No other compensation promise",
      paragraphs: [
        "This Agreement does not promise a minimum number of leads, territories, hours, sales, or earnings. Contractor is not authorized to alter customer pricing or make compensation commitments on behalf of the Company.",
      ],
    },
    {
      heading: "7. Company obligations only; signature in a representative capacity",
      paragraphs: [
        "All obligations under this Agreement are obligations of the Company alone and are satisfied solely from Company assets. The Company’s authorized representative signs only in that representative capacity on behalf of the Company. That individual, and the Company’s owners, members, managers, employees, and agents, do not assume and are not personally liable for any obligation under this Agreement, and this Agreement does not create any personal guarantee or individual obligation of any of them.",
      ],
    },
  ];
}

function confidentialitySections({ companyName }: TemplateContext): AgreementSection[] {
  return [
    {
      heading: "1. Protected information",
      paragraphs: [
        `Contractor may receive confidential information belonging to ${companyName}, service providers, customers, applicants, and other representatives. Protected information includes lead and address data, customer contact and order information, credentials, pricing not publicly released, territory plans, sales methods, compensation records, provider integrations, source code, reports, and nonpublic business information.`,
      ],
    },
    {
      heading: "2. Permitted use",
      paragraphs: [
        "Contractor will use protected information only to perform authorized work, disclose it only to authorized persons with a business need, and apply reasonable safeguards. Contractor will not export, scrape, sell, share, photograph, or retain protected information outside approved systems except where the Company has expressly authorized it.",
      ],
    },
    {
      heading: "3. Security duties",
      bullets: [
        "Use an individual account, strong device passcode, current software, and multi-factor or one-time-code authentication when provided.",
        "Never share passwords, login codes, customer records, or provider credentials.",
        "Do not access records beyond the territory or work assigned to you.",
        "Report a lost device, suspicious login, mistaken disclosure, or suspected breach to a manager immediately.",
        "Delete local copies and return Company property when requested or when the engagement ends.",
      ],
      paragraphs: [],
    },
    {
      heading: "4. Exclusions and lawful reporting",
      paragraphs: [
        "This Agreement does not restrict information that becomes public without Contractor’s breach, was lawfully known without a duty of confidentiality, is independently developed, or is lawfully received from another source. Nothing here prohibits reporting suspected unlawful conduct to a government agency, cooperating with an investigation, or making another disclosure protected by law.",
      ],
    },
    {
      heading: "5. Duration and return",
      paragraphs: [
        "These duties continue while information remains confidential or protected by law. Upon request or termination, Contractor will stop access and return or securely delete protected information, subject to records the Company must retain.",
      ],
    },
  ];
}

function safetySections(): AgreementSection[] {
  return [
    {
      heading: "1. Customer respect and identification",
      bullets: [
        "Wear or display approved identification and state your name, company, and purpose truthfully.",
        "Honor every no-soliciting sign, customer refusal, request to leave, and property restriction immediately.",
        "Never pressure, threaten, harass, discriminate, impersonate a provider or utility, or claim government affiliation.",
        "Do not enter a residence, fenced area, or restricted property unless expressly authorized and permitted by Company policy.",
      ],
      paragraphs: [],
    },
    {
      heading: "2. Safe field practices",
      bullets: [
        "Work only during lawful solicitation hours and comply with local permit, registration, and identification rules.",
        "Remain alert around traffic, animals, stairs, construction, weather, and poorly lit areas; leave when conditions feel unsafe.",
        "Do not drive while using the portal, enter active construction zones, touch utility equipment, or represent that you can perform technical work.",
        "Use the buddy or check-in process required for the assigned market and promptly report an injury, threat, vehicle incident, or unsafe location.",
      ],
      paragraphs: [],
    },
    {
      heading: "3. Sales accuracy and customer privacy",
      paragraphs: [
        "Use only current approved scripts and offers. Confirm material price, term, installation, equipment, eligibility, and cancellation information before submitting an order. Collect only information required for the authorized transaction and enter it directly into approved systems out of public view.",
      ],
    },
    {
      heading: "4. Prohibited conduct",
      paragraphs: [
        "Weapons, alcohol, illegal drugs, violence, retaliation, falsified visits, fabricated consent, forged signatures, unauthorized recordings, and misuse of customer or Company data are prohibited while performing Company work. A serious or repeated violation may result in immediate loss of access and termination of the engagement.",
      ],
    },
    {
      heading: "5. Stop-work authority",
      paragraphs: [
        "Contractor may stop work and contact a manager whenever a situation appears unsafe, unlawful, deceptive, or outside training. No sales opportunity requires Contractor to remain in an unsafe situation.",
      ],
    },
  ];
}

const BUILDERS: Record<OnboardingDocumentType, (context: TemplateContext) => AgreementSection[]> = {
  independent_contractor: contractorSections,
  commission_agreement: commissionSections,
  confidentiality: confidentialitySections,
  field_safety: safetySections,
};

export function buildAgreementSnapshot(input: TemplateContext & { documentType: OnboardingDocumentType }): AgreementSnapshot {
  return {
    schemaVersion: 1,
    documentType: input.documentType,
    documentVersion: AGREEMENT_VERSION,
    title: ONBOARDING_DOCUMENT_META[input.documentType].label,
    companyName: input.companyName,
    signerName: input.signerName,
    signerEmail: input.signerEmail.toLowerCase(),
    issuedAt: input.issuedAt,
    sections: BUILDERS[input.documentType](input),
  };
}
