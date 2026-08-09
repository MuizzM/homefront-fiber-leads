import {
  ONBOARDING_DOCUMENT_META,
  type AgreementSection,
  type AgreementSnapshot,
  type OnboardingDocumentType,
} from "../shared/onboardingDocuments";
import {
  DEFAULT_COMMISSION_TERMS, describeCommissionTerms, tierRows, type CommissionTerms,
} from "../shared/commissionTerms";
import { formatUsdCents } from "../shared/commissionTiers";

// ─────────────────────────────────────────────────────────────────────────────
// ⚠️  INTERNAL LEGAL-REVIEW NOTE — NOT signer-facing. Do not remove.
//
// These agreements are a good-faith DRAFT written by engineers, not lawyers.
// They MUST be reviewed and approved by qualified North Carolina counsel before
// production use. This comment is the conspicuous internal notice; it is
// intentionally absent from the rendered agreement the contractor signs.
//
// Points counsel should look at first, because they are the ones most likely to
// be wrong in a way that costs money:
//
//   · CLASSIFICATION. A document calling someone an independent contractor does
//     not make them one. The IRS common-law test, the NC Industrial Commission,
//     and the US DOL all look at ACTUAL control — schedules set by the company,
//     required meetings, mandatory hours, discipline, exclusivity. The 1099
//     language here is only as true as day-to-day practice makes it, and
//     misclassification exposure (back taxes, wage claims, workers' comp,
//     penalties) is the single largest legal risk in this model.
//   · NON-SOLICITATION (§11). Drafted narrowly — 12 months, only customers the
//     contractor personally sold, only reps they personally worked with, no
//     geographic or industry restraint — because NC courts will strike an
//     overbroad restraint rather than rewrite it, and "blue-pencil" relief is
//     limited. Widening this makes it MORE likely to fail entirely.
//   · LIMITATION OF LIABILITY (§9) and INDEMNIFICATION (§8). Enforceable scope
//     varies; some claims cannot be limited or shifted by contract.
//   · COMMISSION FORFEITURE / OFFSET (§10, Commission §4-5, §7). NC wage-payment
//     rules constrain deductions and forfeiture of earned compensation. The
//     "earned" definition and the reserve mechanic are where that bites.
//   · CHARGEBACK RESERVE. Whether holding a percentage of earned commission is
//     permissible, and on what notice, is a state-law question.
//   · CONSUMER PROTECTION. The FTC Cooling-Off Rule and NC home-solicitation
//     provisions impose customer-facing notice duties this document only
//     obliges the contractor to follow — confirm the CUSTOMER-facing paperwork
//     satisfies them too.
// ─────────────────────────────────────────────────────────────────────────────

// Bumped to 2026.08.2: the Commission Agreement now STATES the rep's actual
// rate, tier ladder and reserve percentage instead of incorporating "the
// structure assigned in the portal" by reference and printing no figure. That
// is a material change to what a signer is agreeing to, so the version moves
// and every rep re-signs — the "sign the current version" gate is how material
// terms get re-consented.
//
// Bumped to 2026.08.4: Section 1 now prints the rate table itself, and — the
// substantive half — the ladder a manager picked when INVITING the candidate
// now reaches this document. Before, an invite could say TIERED and carry no
// ladder, so the agreement rendered the house bands and the signer had no way
// to tell. Same gate, same reason: what a signer reads changed.
export const AGREEMENT_VERSION = "2026.08.4";

// The Company's legal identity, stated once. Sections use "the Company"
// thereafter, per the requirement to minimize use of the full legal name.
const COMPANY_LEGAL_NAME = "HomeFront Solutions LLC";
const COMPANY_ADDRESS = "605 Abbie Ave, High Point, NC 27263";
const RESERVE_RELEASE_DAYS = 90;

interface TemplateContext {
  companyName: string;
  signerName: string;
  signerEmail: string;
  issuedAt: string;
  /** The comp terms this rep is being offered. Optional only so an older
   *  caller still renders; every issue path resolves and passes them. */
  compTerms?: CommissionTerms;
}

function contractorSections({ companyName }: TemplateContext): AgreementSection[] {
  return [
    {
      heading: "1. Engagement and non-exclusivity",
      paragraphs: [
        `${companyName} (the “Company”) engages the signer (the “Contractor”) to identify prospective customers, explain authorized fiber-service offers, and submit accurate orders and field activity through Company systems. Contractor accepts this engagement subject to this Agreement and the Company’s written compliance and safety policies.`,
        // Non-exclusivity and no-minimum are not generosity — they are two of the
        // facts that distinguish a contractor from an employee, and stating them
        // is part of what makes the classification defensible.
        "This engagement is NON-EXCLUSIVE. Contractor is free to perform services for others, including other sales organizations, provided Contractor does not use the Company’s confidential information or breach Section 11. The Company does not guarantee any minimum number of leads, appointments, hours, territories, sales, or earnings, and Contractor is not required to accept any particular assignment.",
      ],
    },
    {
      heading: "2. Independent contractor status",
      paragraphs: [
        "Contractor is an independent contractor and NOT an employee, partner, joint venturer, franchisee, or agent of the Company. Contractor controls the manner, means, methods, sequence, hours, and schedule of the work, subject only to applicable law, customer consent, territory assignments, service-provider requirements, and the Company’s compliance and safety standards. The Company directs the RESULT to be achieved, not the manner in which Contractor achieves it.",
        "Contractor supplies their own vehicle, phone, and ordinary equipment, bears their own expenses, and may engage their own helpers or subcontractors at Contractor’s sole cost - in which case Contractor is solely responsible for those persons, for their conduct, and for their pay, taxes, and insurance, and will bind them to obligations at least as protective as this Agreement.",
        "Contractor has NO authority to bind the Company or any service provider, to make representations or promises on the Company’s behalf beyond approved materials, to alter customer pricing or terms, to hold themself out as an employee, or to open accounts, incur obligations, or accept service of process for the Company.",
      ],
    },
    {
      heading: "3. Taxes - Form 1099, no withholding",
      paragraphs: [
        "Contractor is compensated on a commission-only basis and is paid as an independent contractor. The Company will NOT withhold federal, state, or local income tax, FICA/Social Security, Medicare, unemployment insurance, or any other amount from Contractor’s compensation. Contractor is solely responsible for self-employment tax, estimated tax payments, and all federal, state, and local taxes arising from this engagement.",
        "Contractor will furnish a completed and accurate IRS Form W-9 (or Form W-8 series if applicable) before any payment is made. The Company will report compensation on IRS Form 1099-NEC where required by law. The Company may withhold payment until a valid taxpayer identification number is on file, and may apply backup withholding if required by the Internal Revenue Code.",
        "No wages, overtime, benefits, health insurance, retirement contributions, paid leave, expense reimbursement, unemployment benefits, or workers’ compensation coverage are provided or promised by this Agreement. Contractor acknowledges they are not covered by the Company’s workers’ compensation policy and is responsible for their own coverage where required.",
      ],
    },
    {
      heading: "4. Licensing, permits, and legal compliance",
      paragraphs: [
        "Contractor will obtain and maintain, at Contractor’s expense, every licence, registration, permit, and local solicitation authorisation required to perform the work in each area worked, and will produce evidence of them on request.",
        "Contractor will comply with all laws applicable to door-to-door and telephone solicitation, including the Telephone Consumer Protection Act and its Do-Not-Call requirements, state and municipal home-solicitation and canvassing ordinances, curfews and permit rules, the FTC Cooling-Off Rule and any state right-of-rescission requirement, all consumer-protection, unfair-and-deceptive-practices, privacy, data-security, anti-discrimination, and trespass laws, and every posted no-soliciting restriction.",
        "Contractor will never misrepresent service availability, price, promotional terms, contract length, affiliation with any carrier or utility, installation timing, or savings; will never imply government or utility affiliation; and will never use another person’s identity, credentials, or sales credentials. Contractor may not collect customer money, payment-card data, or bank details unless expressly authorised in a signed writing.",
      ],
    },
    {
      heading: "5. Accurate records and truthful sales",
      paragraphs: [
        "Contractor will enter complete and truthful lead, visit, consent, and sale information promptly, and will not create, submit, or cause to be submitted any order that is fabricated, duplicated, unauthorised, obtained by misrepresentation, or lacking the customer’s informed consent.",
        "A falsified, forged, or unauthorised submission is a material breach. In addition to every other remedy, the Company may reverse and recover all compensation associated with it, withhold or offset amounts otherwise payable, terminate this Agreement immediately, and report the conduct to the affected carrier and to law enforcement or regulators where required.",
        "Contractor will cooperate promptly and fully with reasonable investigations of complaints, chargebacks, safety incidents, fraud, or regulatory inquiries, including after the engagement ends.",
      ],
    },
    {
      heading: "6. Insurance",
      paragraphs: [
        "Contractor will maintain, at Contractor’s expense and for the duration of this engagement, valid automobile liability insurance meeting at least the minimum limits required by the state in which Contractor drives while performing the work, and will produce a certificate on request. Contractor is encouraged to maintain general liability coverage appropriate to the work. Failure to maintain required coverage is grounds for immediate termination.",
      ],
    },
    {
      heading: "7. Company property, leads, and work product",
      paragraphs: [
        "All leads, customer lists, address and territory data, scan and availability data, pricing, sales methods, scripts, software, credentials, badges, branded materials, and any records generated in the course of the work are and remain the exclusive property of the Company, regardless of who created or collected them.",
        "To the extent Contractor acquires any right in such material, Contractor assigns it to the Company and will execute any document reasonably necessary to perfect that assignment. Contractor acquires no right to use, retain, copy, sell, or disclose customer or lead data for any purpose outside performing this engagement, and will return or delete all Company property, data, and credentials when the engagement ends.",
      ],
    },
    {
      heading: "8. Indemnification",
      paragraphs: [
        // The core protective clause for door-to-door work: the conduct that
        // creates liability happens at somebody's front door, out of sight.
        "Contractor will indemnify, defend, and hold harmless the Company, its owners, officers, employees, affiliates, and service providers from and against any claim, demand, action, investigation, penalty, loss, damage, liability, cost, and expense (including reasonable attorneys’ fees) arising out of or relating to: (a) Contractor’s acts or omissions, including those of Contractor’s helpers or subcontractors; (b) any misrepresentation, unauthorised promise, fabricated or unauthorised order, or breach of this Agreement; (c) Contractor’s violation of any law, licence requirement, or third-party right, including solicitation, privacy, consumer-protection, and trespass laws; (d) any claim that Contractor or Contractor’s personnel were employees of the Company, or any resulting tax, wage, benefit, or insurance liability; and (e) Contractor’s use or operation of any vehicle.",
        "This obligation survives termination of the engagement.",
      ],
    },
    {
      heading: "9. Limitation of liability",
      paragraphs: [
        "The Company’s total cumulative liability to Contractor for any and all claims arising out of or relating to this engagement will not exceed the total commissions actually earned and payable to Contractor in the ninety (90) days immediately preceding the event giving rise to the claim. Neither party is liable for indirect, incidental, special, consequential, exemplary, or punitive damages, or for lost profits or lost business opportunity, even if advised of the possibility. Nothing in this Section limits either party’s liability where applicable law does not permit it to be limited, or limits Contractor’s obligations under Section 8.",
      ],
    },
    {
      heading: "10. Term, termination, and offset",
      paragraphs: [
        "Either party may end the engagement at any time, with or without cause, by written or electronic notice, subject to payment of commissions already EARNED under the Commission Agreement. The Company may suspend Contractor’s access immediately, without prior notice, where it reasonably suspects fraud, a safety incident, a licensing failure, or a legal or carrier-compliance violation.",
        "The Company may set off against any amount otherwise payable to Contractor any chargeback, reversal, overpayment, advance, debt, unreturned-property cost, or other amount Contractor owes the Company, to the extent applicable law allows. No deduction or offset will reduce compensation below any limit imposed by applicable law.",
      ],
    },
    {
      heading: "11. Non-solicitation",
      paragraphs: [
        // Deliberately narrow: overreaching restraints are the ones courts strike
        // down, and a clause that fails entirely protects nobody. Duration,
        // geography and target are all bounded, and it is a NON-SOLICIT — it does
        // not stop Contractor working in the industry.
        "For twelve (12) months after this engagement ends, Contractor will not knowingly (a) solicit, for a competing fiber or broadband offering, any customer Contractor personally sold or serviced on the Company’s behalf during the final twelve (12) months of the engagement, or (b) induce any of the Company’s representatives or contractors with whom Contractor personally worked during that period to end their engagement with the Company.",
        "This Section does not restrict Contractor from working in the industry, from working in any geography, or from serving customers Contractor did not obtain through the Company. The parties intend this restriction to be no broader than reasonably necessary to protect the Company’s customer relationships and confidential information, and a court may reduce its duration or scope rather than decline to enforce it.",
      ],
    },
    {
      heading: "12. Background check and eligibility",
      paragraphs: [
        "Contractor authorises the Company to obtain a background check and driving record where permitted by law, and will notify the Company promptly of any criminal charge, licence suspension, or carrier or regulatory action that would affect eligibility to perform the work. Contractor represents that they are legally permitted to work as an independent contractor in the United States and that all information provided during onboarding is true.",
      ],
    },
    {
      heading: "13. Governing law and disputes",
      paragraphs: [
        "This Agreement is governed by the laws of the State of North Carolina, without regard to its conflict-of-laws rules. The parties consent to the exclusive jurisdiction and venue of the state and federal courts located in Guilford County, North Carolina, for any dispute arising out of or relating to this engagement.",
        "The prevailing party in any action to enforce this Agreement is entitled to recover its reasonable attorneys’ fees and costs to the extent permitted by law. Each party will bear its own fees where the law does not permit recovery.",
      ],
    },
    {
      heading: "14. General",
      paragraphs: [
        "ASSIGNMENT. The Company may assign this Agreement to an affiliate or successor. Contractor may not assign or delegate this Agreement without the Company’s prior written consent.",
        "NOTICES. Notice may be given by email to the address each party has on file in the Company’s portal, and is effective when sent.",
        "SURVIVAL. Sections 3, 5, 7, 8, 9, 10, 11, 13, and 14, and the confidentiality, data-protection, records, payment-adjustment, and prior-conduct obligations of the related agreements, survive termination.",
        "NO WAIVER; SEVERABILITY. A failure to enforce a provision is not a waiver of it. If a provision is held unenforceable, it is modified to the minimum extent necessary to make it enforceable, or severed, and the remaining provisions continue in full force.",
        "ENTIRE AGREEMENT. This Agreement, the Commission Agreement, the Confidentiality & Data Security Agreement, the Field Safety & Conduct Agreement, and incorporated written policies form the parties’ entire agreement about the engagement and supersede prior discussions. Any amendment must be recorded in a later writing or electronic record accepted by both parties.",
      ],
    },
  ];
}

function commissionSections(ctx: TemplateContext): AgreementSection[] {
  // The terms the manager chose when sending this paperwork. Falling back to
  // the house default keeps an older caller working, but every issue path now
  // resolves and passes real terms — see resolveCommissionTerms.
  const terms = ctx.compTerms ?? DEFAULT_COMMISSION_TERMS;
  return [
    {
      heading: "1. Parties and commission plan",
      paragraphs: [
        `This Commission Agreement is between ${COMPANY_LEGAL_NAME}, ${COMPANY_ADDRESS} (the “Company”), and the signer (the “Contractor”). The Company will compensate the Contractor on the terms stated in this Section, which were set for this engagement when this Agreement was issued.`,
        // The numbers themselves. This is the change: the agreement used to
        // incorporate the ladder "by reference" to the portal and print no
        // figure at all, so a contractor could not read what they would be paid.
        ...describeCommissionTerms(terms),
        "The Company may change the commission structure prospectively by a new written or electronic notice with an effective date. A commission already earned under a prior effective-dated structure will not be reduced solely because the structure changes afterward.",
      ],
      // The same numbers as the prose above, as a table. Built from tierRows, so
      // the two cannot state different bands — a document that contradicts
      // itself about pay is worse than one that states it only once. A FLAT plan
      // gets the single row the packet cover already uses.
      rows: terms.structure === "FLAT" && terms.flatRateCents != null
        ? [{ band: "Every qualified sale", rate: `${formatUsdCents(terms.flatRateCents)} per sale` }]
        : tierRows(terms),
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
        // The rate here is the one the manager set, not a constant. A rep on a
        // 0% or 20% hold used to sign a document that said 10% regardless.
        `The Company will withhold ${terms.reservePercent}% of otherwise payable commissions as a chargeback reserve. The remaining ${100 - terms.reservePercent}% is paid on the normal payout schedule. The reserve secures the Company against later chargebacks, reversals, and related amounts described in this Agreement.`,
        `The reserve is calculated per pay period as ${terms.reservePercent}% of the Contractor’s otherwise payable commissions for that period, tracked as a running balance${terms.reserveCapCents > 0 ? ` and capped at ${formatUsdCents(terms.reserveCapCents)}` : ""}. Each contribution to, draw against, and release from the reserve is shown on the Contractor’s commission statements in the portal, so the balance can be reconciled against the underlying sales.`,
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
      heading: "6. Commission-only; no other compensation promise",
      paragraphs: [
        "Compensation under this Agreement is COMMISSION ONLY. Contractor is not paid a salary, wage, hourly rate, draw, guarantee, or minimum, and is not entitled to overtime, benefits, expense reimbursement, or paid time off. Contractor is paid as an independent contractor and receives IRS Form 1099-NEC where required; no amounts are withheld for taxes (see Section 3 of the Independent Contractor Agreement).",
        "This Agreement does not promise a minimum number of leads, territories, hours, sales, or earnings. Contractor is not authorized to alter customer pricing or make compensation commitments on behalf of the Company.",
        "An unearned advance or draw, if the Company ever chooses to extend one, is a recoverable advance against future commissions and remains repayable to the extent applicable law allows. No advance is promised by this Agreement.",
      ],
    },
    {
      heading: "7. Post-termination commissions",
      paragraphs: [
        // The most common source of a commission dispute: a sale submitted just
        // before the engagement ends but installed after. Silence here is what
        // produces the argument.
        "A commission on an order submitted before the engagement ends remains payable ONLY if the order satisfies every qualification condition in Section 2 after termination, including installation, validation, and the absence of cancellation or chargeback. Such commissions are paid on the normal schedule following qualification, net of the reserve and any offset.",
        "An order that does not qualify, or that is cancelled, reversed, or charged back after termination, is not earned and any amount already paid for it may be recovered or offset against the remaining reserve balance as described in Section 4.",
      ],
    },
    {
      heading: "8. Company obligations only; signature in a representative capacity",
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
    // Frozen alongside the prose it produced. The snapshot is already the
    // immutable, audited record of what was signed; carrying the structured
    // terms in it means "what was this rep actually promised" is answerable
    // later by reading data, not by re-parsing a paragraph.
    ...(input.documentType === "commission_agreement" && input.compTerms
      ? { compTerms: input.compTerms }
      : {}),
    sections: BUILDERS[input.documentType](input),
  };
}
