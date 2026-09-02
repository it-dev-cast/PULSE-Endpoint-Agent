// Real TPM-backed device identity for hardware-check baseline signing (PRD Section 6.1's
// "cryptographically signed using the device TPM" and Section 14.1's "TPM-backed Device
// Identity"). Uses Windows' own Microsoft Platform Crypto Provider (PCP) - the same CNG Key
// Storage Provider BitLocker/Windows Hello/virtual smart cards already use - not the
// cross-platform TCG TSS2 stack (tss-esapi): that crate's C dependency (tpm2-tss) has no mature,
// confirmed-working Windows TBS backend reachable from this project's pure-Cargo build pipeline
// (both real Rust TSS successors to the now-deprecated tpm2-rs are pre-production - "currently
// very unstable" in the maintainers' own words - and pulling in tpm2-tss would be this project's
// first native C build dependency). PCP is reachable entirely through the `windows` crate this
// project already depends on - zero new native toolchain, zero new crates. Google's own
// go-attestation library uses this exact same PCP mechanism for real Windows TPM attestation
// (attest/pcp_windows.go) - independent validation this is the idiomatic path on Windows, not a
// workaround.
//
// What this proves: a real, non-exportable ECDSA P-256 key whose private part never leaves the
// TPM (created via NCryptCreatePersistedKey, NCRYPT_ALLOW_EXPORT_FLAG never set), used to sign
// the exact hardware-fingerprint JSON bytes posted to backend/'s hardware-check endpoint - real
// TPM-backed device identity per PRD Section 14.1's literal wording.
//
// What this does NOT prove: a formal TCG-spec TPM Quote (EK certificate chain + PCR selection +
// TPM2_Quote) a remote verifier could check against the manufacturer's EK root - PRD Section
// 14.2's fuller ask. That needs either a mature Windows-capable Rust TSS (none exists yet) or
// hand-rolled raw TPM2 command encoding over Tbsip_Submit_Command - deliberately not attempted
// here. This module's own name and this comment say exactly what it proves, on purpose.
//
// NCRYPT_PCP_KEYATTESTATION_PROPERTY's literal value (KEY_ATTESTATION_PROPERTY below) is inferred
// from the one PCP property Microsoft's own TSS.MSR header (PCPTool.v11/inc/TpmAtt.h) confirms
// the real naming pattern for (NCRYPT_PCP_PLATFORM_BINDING_PCRALGID_PROPERTY ->
// L"PCP_PLATFORM_BINDING_PCRALGID"), not independently confirmed for this exact property name.
// Treated accordingly: a wrong string here just makes NCryptGetProperty return a clean, detectable
// error - fetch_key_attestation degrades to None on ANY failure rather than treating it as fatal,
// since it's supplementary proof-of-TPM-residency, not the signature itself. The signature and
// non-exportable key creation - the actual security property - depend only on generic, fully
// Microsoft-documented NCrypt/BCrypt APIs, none of which carry this same uncertainty.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use windows::core::PCWSTR;
use windows::Win32::Security::Cryptography::{
    BCryptCloseAlgorithmProvider, BCryptHash, BCryptOpenAlgorithmProvider, NCryptCreatePersistedKey,
    NCryptExportKey, NCryptFinalizeKey, NCryptFreeObject, NCryptGetProperty, NCryptOpenKey,
    NCryptOpenStorageProvider, NCryptSignHash, BCRYPT_ALG_HANDLE, CERT_KEY_SPEC, NCRYPT_FLAGS,
    NCRYPT_HANDLE, NCRYPT_KEY_HANDLE, NCRYPT_PROV_HANDLE,
};

const PROVIDER_NAME: &str = "Microsoft Platform Crypto Provider";
const KEY_NAME: &str = "PulseEndpointDeviceIdentity";
const ALGORITHM_ECDSA_P256: &str = "ECDSA_P256";
const BLOB_TYPE_ECC_PUBLIC: &str = "ECCPUBLICBLOB";
const KEY_ATTESTATION_PROPERTY: &str = "PCP_KEYATTESTATION";
const SHA256_ALGORITHM: &str = "SHA256";

// NCRYPT_MACHINE_KEY_FLAG (0x20): this is a DEVICE identity, not tied to whichever Windows user
// happens to be signed in when the ONLOGON-triggered scheduled task runs it.
// NCRYPT_SILENT_FLAG (0x40): guarantees no UI prompt ever appears - this runs in a hidden
// scheduled task with no interactive session to show one to; a prompt here would hang forever.
const KEY_FLAGS: u32 = 0x20 | 0x40;

// Real CNG ECC public-key blob header magic for a P-256 public key (BCRYPT_ECCKEY_BLOB.dwMagic) -
// stable since Windows 7's original CNG ECC support, unchanged since. Confirmed directly against
// Microsoft's own bcrypt.h value. cbKey (the second header field) is always 32 for P-256; the
// header is followed by the raw X then Y coordinates, 32 bytes each, big-endian - the header is
// stripped off in export_public_key below rather than sent, since the backend only needs the raw
// X||Y coordinate pair to reconstruct an ecdsa.PublicKey, not this CNG-specific blob framing.
const BCRYPT_ECDSA_PUBLIC_P256_MAGIC: u32 = 0x3153_4345;
const ECC_BLOB_HEADER_LEN: usize = 8; // dwMagic (u32) + cbKey (u32)
const P256_COORD_LEN: usize = 32;

pub struct DeviceIdentity {
    /// Base64 of the raw r||s ECDSA signature (64 bytes for P-256 - NCryptSignHash's own real
    /// output shape for ECDSA keys is this raw IEEE P1363 form, not ASN.1 DER).
    pub signature_b64: String,
    /// Base64 of the raw X||Y public key coordinates (64 bytes for P-256), only present on the
    /// cycle that created the key - a device only ever needs to send its public key once.
    pub public_key_b64: Option<String>,
    /// Base64 of the raw NCRYPT_PCP_KEYATTESTATION_PROPERTY blob (proof the signing key is
    /// genuinely TPM-resident), only present on the cycle that created the key. None if this
    /// property couldn't be read - see this file's own top comment on why that's tolerated.
    pub key_attestation_b64: Option<String>,
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn err_msg(context: &str, e: &windows::core::Error) -> String {
    format!("{context}: {e} (0x{:08X})", e.code().0)
}

/// SHA-256 of `data` via BCrypt (already part of this project's `windows` crate dependency - no
/// new hashing crate needed for one hash call).
fn sha256(data: &[u8]) -> Result<[u8; 32], String> {
    unsafe {
        let mut alg = BCRYPT_ALG_HANDLE::default();
        let alg_id = wide(SHA256_ALGORITHM);
        BCryptOpenAlgorithmProvider(&mut alg, PCWSTR(alg_id.as_ptr()), PCWSTR::null(), Default::default())
            .ok()
            .map_err(|e| err_msg("BCryptOpenAlgorithmProvider(SHA256)", &e))?;

        let mut out = [0u8; 32];
        let status = BCryptHash(alg, None, data, &mut out);
        let _ = BCryptCloseAlgorithmProvider(alg, 0);
        status.ok().map_err(|e| err_msg("BCryptHash", &e))?;
        Ok(out)
    }
}

/// Opens the persisted device-identity key if it already exists, else creates it (non-exportable
/// ECDSA P-256, machine-scoped). Real idempotent get-or-create - never NCRYPT_OVERWRITE_KEY_FLAG,
/// since silently replacing an existing device identity key would rotate it without anyone
/// deciding to (the one deliberate way to do that is the existing "Reset FP" flow, which this
/// module does not touch).
unsafe fn open_or_create_key(provider: NCRYPT_PROV_HANDLE) -> Result<(NCRYPT_KEY_HANDLE, bool), String> {
    let key_name = wide(KEY_NAME);
    let mut key = NCRYPT_KEY_HANDLE::default();

    let opened = unsafe {
        NCryptOpenKey(provider, &mut key, PCWSTR(key_name.as_ptr()), CERT_KEY_SPEC(0), NCRYPT_FLAGS(KEY_FLAGS))
    };
    if opened.is_ok() {
        return Ok((key, false));
    }

    let algo = wide(ALGORITHM_ECDSA_P256);
    unsafe {
        NCryptCreatePersistedKey(
            provider,
            &mut key,
            PCWSTR(algo.as_ptr()),
            PCWSTR(key_name.as_ptr()),
            CERT_KEY_SPEC(0),
            NCRYPT_FLAGS(KEY_FLAGS),
        )
    }
    .map_err(|e| err_msg("NCryptCreatePersistedKey", &e))?;

    if let Err(e) = unsafe { NCryptFinalizeKey(key, NCRYPT_FLAGS(KEY_FLAGS)) } {
        let _ = unsafe { NCryptFreeObject(NCRYPT_HANDLE(key.0)) };
        return Err(err_msg("NCryptFinalizeKey", &e));
    }
    Ok((key, true))
}

unsafe fn sign_hash(key: NCRYPT_KEY_HANDLE, hash: &[u8; 32]) -> Result<Vec<u8>, String> {
    let mut needed: u32 = 0;
    unsafe { NCryptSignHash(key, None, hash, None, &mut needed, NCRYPT_FLAGS(0)) }
        .map_err(|e| err_msg("NCryptSignHash(size query)", &e))?;

    let mut sig = vec![0u8; needed as usize];
    let mut written: u32 = 0;
    unsafe { NCryptSignHash(key, None, hash, Some(&mut sig), &mut written, NCRYPT_FLAGS(0)) }
        .map_err(|e| err_msg("NCryptSignHash", &e))?;
    sig.truncate(written as usize);
    Ok(sig)
}

/// Raw X||Y (64 bytes for P-256) - the CNG ECCPUBLICBLOB header (magic + cbKey) is stripped here
/// rather than sent, since the backend reconstructs an ecdsa.PublicKey directly from the two raw
/// big-endian coordinates and has no reason to understand this Windows-specific blob framing.
unsafe fn export_public_key(key: NCRYPT_KEY_HANDLE) -> Result<Vec<u8>, String> {
    let blob_type = wide(BLOB_TYPE_ECC_PUBLIC);
    let mut needed: u32 = 0;
    unsafe { NCryptExportKey(key, None, PCWSTR(blob_type.as_ptr()), None, None, &mut needed, NCRYPT_FLAGS(0)) }
        .map_err(|e| err_msg("NCryptExportKey(size query)", &e))?;

    let mut blob = vec![0u8; needed as usize];
    let mut written: u32 = 0;
    unsafe { NCryptExportKey(key, None, PCWSTR(blob_type.as_ptr()), None, Some(&mut blob), &mut written, NCRYPT_FLAGS(0)) }
        .map_err(|e| err_msg("NCryptExportKey", &e))?;
    blob.truncate(written as usize);

    if blob.len() != ECC_BLOB_HEADER_LEN + 2 * P256_COORD_LEN {
        return Err(format!(
            "unexpected ECCPUBLICBLOB length {} (expected {})",
            blob.len(),
            ECC_BLOB_HEADER_LEN + 2 * P256_COORD_LEN
        ));
    }
    let magic = u32::from_le_bytes(blob[0..4].try_into().unwrap());
    if magic != BCRYPT_ECDSA_PUBLIC_P256_MAGIC {
        return Err(format!("unexpected ECCPUBLICBLOB magic {magic:#010X} (expected a P-256 public key)"));
    }
    Ok(blob[ECC_BLOB_HEADER_LEN..].to_vec())
}

/// Best-effort only - see this file's own top comment on why the exact property-name string
/// isn't independently confirmed, and why that's tolerated here specifically (unlike every other
/// call in this module, which is fatal to the whole sign_fingerprint call on failure).
unsafe fn fetch_key_attestation(key: NCRYPT_KEY_HANDLE) -> Option<Vec<u8>> {
    let prop = wide(KEY_ATTESTATION_PROPERTY);
    let handle = NCRYPT_HANDLE(key.0);
    let mut needed: u32 = 0;
    let queried = unsafe { NCryptGetProperty(handle, PCWSTR(prop.as_ptr()), None, &mut needed, Default::default()) };
    if queried.is_err() || needed == 0 {
        return None;
    }
    let mut blob = vec![0u8; needed as usize];
    let mut written: u32 = 0;
    let fetched = unsafe { NCryptGetProperty(handle, PCWSTR(prop.as_ptr()), Some(&mut blob), &mut written, Default::default()) };
    if fetched.is_err() {
        return None;
    }
    blob.truncate(written as usize);
    Some(blob)
}

/// The one real entry point: sign `payload` (the exact hardware-fingerprint JSON bytes
/// telemetry-server.mjs is about to POST, unchanged - no re-normalization here, see the design
/// note this was built from) with this device's persisted TPM identity key, creating that key
/// first if this is the very first hardware-check to ever run on this machine.
pub fn sign_fingerprint(payload: &[u8]) -> Result<DeviceIdentity, String> {
    unsafe {
        let mut provider = NCRYPT_PROV_HANDLE::default();
        let provider_name = wide(PROVIDER_NAME);
        NCryptOpenStorageProvider(&mut provider, PCWSTR(provider_name.as_ptr()), 0)
            .map_err(|e| err_msg("NCryptOpenStorageProvider", &e))?;

        let key_result = open_or_create_key(provider);
        let (key, created_now) = match key_result {
            Ok(v) => v,
            Err(e) => {
                let _ = NCryptFreeObject(NCRYPT_HANDLE(provider.0));
                return Err(e);
            }
        };

        let result = (|| {
            let hash = sha256(payload)?;
            let signature = sign_hash(key, &hash)?;
            let (public_key_b64, key_attestation_b64) = if created_now {
                let pubkey = export_public_key(key)?;
                let attestation = fetch_key_attestation(key);
                (Some(BASE64.encode(pubkey)), attestation.map(|a| BASE64.encode(a)))
            } else {
                (None, None)
            };
            Ok(DeviceIdentity { signature_b64: BASE64.encode(signature), public_key_b64, key_attestation_b64 })
        })();

        let _ = NCryptFreeObject(NCRYPT_HANDLE(key.0));
        let _ = NCryptFreeObject(NCRYPT_HANDLE(provider.0));
        result
    }
}
