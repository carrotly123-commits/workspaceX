package wamodel

// RegistrationOTPWait is the transient registration state persisted while the
// dashboard waits for the user to submit the OTP. It is keyed both by
// verification request and by WA account so either side can look it up.
type RegistrationOTPWait struct {
	WAAccountID           string `json:"wa_account_id"`
	VerificationRequestID string `json:"verification_request_id"`
	ResumeURL             string `json:"resume_url"`
	CreatedAtUnix         int64  `json:"created_at_unix"`
}

func RegistrationOTPWaitKey(verificationRequestID string) string {
	return "wa-registration-otp-wait:verification:" + verificationRequestID
}

func RegistrationOTPWaitAccountKey(waAccountIDValue string) string {
	return "wa-registration-otp-wait:account:" + waAccountIDValue
}
