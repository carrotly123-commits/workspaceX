package bff

import (
	"encoding/json"
	"reflect"
	"testing"
)

// normalizeJSON marshals v and re-parses it into a generic object, so the
// dashboard wire contract (keys/values/types) is compared independently of Go
// struct field ordering.
func normalizeJSON(t *testing.T, v any) map[string]any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("expected a JSON object, got %s: %v", b, err)
	}
	return m
}

// assertJSONContract fails if marshalling got does not produce exactly wantJSON
// (as a JSON object). Both sides are normalised through encoding/json so numeric
// widening is consistent.
func assertJSONContract(t *testing.T, name string, got any, wantJSON string) {
	t.Helper()
	var want map[string]any
	if err := json.Unmarshal([]byte(wantJSON), &want); err != nil {
		t.Fatalf("%s: malformed wantJSON: %v", name, err)
	}
	if g := normalizeJSON(t, got); !reflect.DeepEqual(g, want) {
		gb, _ := json.Marshal(g)
		t.Errorf("%s: JSON contract drift\n got  %s\n want %s", name, gb, wantJSON)
	}
}

func TestFingerprintDTOContract(t *testing.T) {
	assertJSONContract(t, "fingerprintDTO",
		fingerprintDTO{Schema: "sc", ProfileSHA256: "p", PhoneSHA256: "ph", DeviceVendor: "v", DeviceModel: "m", AndroidVersion: "12"},
		`{"schema":"sc","profile_sha256":"p","phone_sha256":"ph","device_vendor":"v","device_model":"m","android_version":"12"}`)
}

func TestTransientFingerprintDTOContract(t *testing.T) {
	assertJSONContract(t, "transientFingerprintDTO",
		transientFingerprintDTO{
			Success:                 true,
			FingerprintRef:          "wafp_1",
			TransientFingerprintRef: "wafp_1",
			FingerprintPersistence:  "TRANSIENT_NOT_COMMITTED",
			Fingerprint:             fingerprintDTO{Schema: "sc"},
		},
		`{"success":true,"fingerprint_ref":"wafp_1","transient_fingerprint_ref":"wafp_1","fingerprint_persistence":"TRANSIENT_NOT_COMMITTED","fingerprint":{"schema":"sc","profile_sha256":"","phone_sha256":"","device_vendor":"","device_model":"","android_version":""}}`)
}

func TestCommitFingerprintDTOContract(t *testing.T) {
	assertJSONContract(t, "commitFingerprintDTO",
		commitFingerprintDTO{
			Success:           true,
			WAAccountID:       "waacc_1",
			ClientProfileID:   "wacp_1",
			ProtocolProfileID: "waproto_native",
			ClientProfile:     map[string]any{"client_profile_id": "wacp_1"},
		},
		`{"success":true,"wa_account_id":"waacc_1","client_profile_id":"wacp_1","protocol_profile_id":"waproto_native","client_profile":{"client_profile_id":"wacp_1"}}`)
}

func TestAwaitOTPDTOContract(t *testing.T) {
	assertJSONContract(t, "awaitOTPDTO",
		awaitOTPDTO{Success: true, WAAccountID: "waacc_1", VerificationRequestID: "wareq_1", TimeoutSeconds: 1200},
		`{"success":true,"wa_account_id":"waacc_1","verification_request_id":"wareq_1","timeout_seconds":1200}`)
}

func TestActionErrorDTOContract(t *testing.T) {
	assertJSONContract(t, "actionErrorDTO",
		actionErrorDTO{Success: false, Error: map[string]any{"code": "WA_ERROR_CODE_INTERNAL", "message": "boom"}, ErrorMessage: "boom"},
		`{"success":false,"error":{"code":"WA_ERROR_CODE_INTERNAL","message":"boom"},"error_message":"boom"}`)
}

// TestActionErrorDTOContract_EmptyMessage guards the omitempty trap: even when
// the message is empty, both keys stay present (the previous map[string]any
// always included them).
func TestActionErrorDTOContract_EmptyMessage(t *testing.T) {
	assertJSONContract(t, "actionErrorDTO(empty message)",
		actionErrorDTO{Success: false, Error: map[string]any{}, ErrorMessage: ""},
		`{"success":false,"error":{},"error_message":""}`)
}

func TestAccountTransferChallengeDTOContract(t *testing.T) {
	assertJSONContract(t, "accountTransferChallengeDTO",
		accountTransferChallengeDTO{Success: true, RegistrationPhase: "ACCOUNT_TRANSFER_WAITING", AccountTransferChallenge: map[string]any{"id": "atc_1"}},
		`{"success":true,"registration_phase":"ACCOUNT_TRANSFER_WAITING","account_transfer_challenge":{"id":"atc_1"}}`)
}

func TestLoginStateResultDTOContract(t *testing.T) {
	assertJSONContract(t, "loginStateResultDTO",
		loginStateResultDTO{Success: false, Status: "LOGIN_STATE_STATUS_REVOKED", LoginState: map[string]any{"status": "REVOKED"}},
		`{"success":false,"status":"LOGIN_STATE_STATUS_REVOKED","login_state":{"status":"REVOKED"}}`)
}

func TestCheckLoginStateResultDTOContract_NoError(t *testing.T) {
	assertJSONContract(t, "checkLoginStateResultDTO(no error)",
		checkLoginStateResultDTO{Success: true, Status: "LOGIN_STATE_CHECK_STATUS_ACTIVE", LoginState: map[string]any{"a": "b"}, Check: map[string]any{"c": "d"}},
		`{"success":true,"status":"LOGIN_STATE_CHECK_STATUS_ACTIVE","login_state":{"a":"b"},"check":{"c":"d"}}`)
}

// The error envelope must appear exactly when there is an error — and its
// message key stays present even when the message is empty (*string vs the
// omitempty-string trap).
func TestCheckLoginStateResultDTOContract_ErrorEmptyMessage(t *testing.T) {
	empty := ""
	assertJSONContract(t, "checkLoginStateResultDTO(error, empty message)",
		checkLoginStateResultDTO{Success: false, Status: "X", LoginState: map[string]any{}, Check: map[string]any{}, Error: map[string]any{"code": "C"}, ErrorMessage: &empty},
		`{"success":false,"status":"X","login_state":{},"check":{},"error":{"code":"C"},"error_message":""}`)
}

// Base request-OTP result: an empty (but non-nil) method_statuses must serialise
// as [] and the three conditional keys must be absent.
func TestRequestSMSOTPResultDTOContract_Base(t *testing.T) {
	assertJSONContract(t, "requestSMSOTPResultDTO(base)",
		requestSMSOTPResultDTO{
			Success: true, Status: "SENT", VerificationRequestID: "wareq_1",
			VerificationRequest: map[string]any{"id": "wareq_1"},
			MethodStatuses:      []map[string]any{},
			Proxy:               map[string]any{"use_proxy": false},
		},
		`{"success":true,"status":"SENT","verification_request_id":"wareq_1","verification_request":{"id":"wareq_1"},"method_statuses":[],"proxy":{"use_proxy":false}}`)
}

// With the conditional keys populated (account-transfer challenge + retry).
func TestRequestSMSOTPResultDTOContract_WithConditionals(t *testing.T) {
	assertJSONContract(t, "requestSMSOTPResultDTO(conditionals)",
		requestSMSOTPResultDTO{
			Success: false, Status: "WAITING", VerificationRequestID: "wareq_2",
			VerificationRequest:      map[string]any{"id": "wareq_2"},
			MethodStatuses:           []map[string]any{{"method": "sms"}},
			Proxy:                    map[string]any{"use_proxy": true},
			AccountTransferChallenge: map[string]any{"id": "atc_1"},
			RegistrationPhase:        "ACCOUNT_TRANSFER_WAITING",
			RetryAfterSeconds:        30,
		},
		`{"success":false,"status":"WAITING","verification_request_id":"wareq_2","verification_request":{"id":"wareq_2"},"method_statuses":[{"method":"sms"}],"proxy":{"use_proxy":true},"account_transfer_challenge":{"id":"atc_1"},"registration_phase":"ACCOUNT_TRANSFER_WAITING","retry_after_seconds":30}`)
}
