package engine

import (
	"encoding/hex"
	"strconv"
	"strings"
	"time"

	waappv1 "github.com/byte-v-forge/wa-app/gen/go/byte/v/forge/waapp/v1"
	"github.com/byte-v-forge/wa-app/internal/waapp/shared"
	"github.com/byte-v-forge/wa-app/internal/waapp/wacore"
	"google.golang.org/protobuf/types/known/timestamppb"
)

type chatdOldRegistrationOTP struct {
	code      string
	deviceID  string
	expiresAt time.Time
}

func chatdDeviceIDFromState(state NativeState) string {
	return chatdDeviceIDFromUUID(state.Profile.FDID)
}

func chatdDeviceIDFromUUID(value string) string {
	compact := strings.ReplaceAll(strings.TrimSpace(value), "-", "")
	raw, err := hex.DecodeString(compact)
	if err != nil || len(raw) != 16 {
		return ""
	}
	return b64u(raw)
}

func oldRegistrationOTPFromChatdNode(node chatdNode, currentDeviceID string, now time.Time) (chatdOldRegistrationOTP, bool, bool) {
	if node.Tag != "notification" {
		return chatdOldRegistrationOTP{}, false, false
	}
	child, ok := chatdChild(node, "wa_old_registration")
	if !ok {
		return chatdOldRegistrationOTP{}, false, false
	}
	otp := chatdOldRegistrationOTP{
		code:      strings.TrimSpace(child.Attrs["code"]),
		deviceID:  strings.TrimSpace(child.Attrs["device_id"]),
		expiresAt: oldRegistrationExpiresAt(child.Attrs["expiry_t"]),
	}
	if otp.code == "" || otp.expiresAt.IsZero() || !now.Before(otp.expiresAt) {
		return otp, true, false
	}
	if currentDeviceID != "" && otp.deviceID == currentDeviceID {
		return otp, true, false
	}
	return otp, true, true
}

func oldRegistrationExpiresAt(value string) time.Time {
	stamp, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	if err != nil || stamp <= 0 {
		return time.Time{}
	}
	if stamp > 1_000_000_000_000 {
		return time.UnixMilli(stamp).UTC()
	}
	return time.Unix(stamp, 0).UTC()
}

func oldRegistrationOTPMessage(input wacore.EngineMessageInput, node chatdNode, otp chatdOldRegistrationOTP, now time.Time) *waappv1.OtpMessage {
	if strings.TrimSpace(input.WAAccountID) == "" || strings.TrimSpace(otp.code) == "" || otp.expiresAt.IsZero() {
		return nil
	}
	otpID := "waotp_old_" + shared.StableID(strings.Join([]string{input.WAAccountID, node.Attrs["id"], otp.code, strconv.FormatInt(otp.expiresAt.Unix(), 10)}, ":"))
	return &waappv1.OtpMessage{
		OtpMessageId:         otpID,
		WaAccountId:          input.WAAccountID,
		ClientProfileId:      input.ClientProfileID,
		RegisteredIdentityId: input.RegisteredIdentityID,
		Source:               waappv1.WaOtpSource_WA_OTP_SOURCE_LONG_CONNECTION,
		SourceParty:          shared.FirstNonEmpty(node.Attrs["from"], "wa_old_registration"),
		Otp:                  &waappv1.SensitiveText{Value: otp.code, RedactedValue: shared.Redacted(otp.code), SecretRef: "wa-otp:" + shared.StableID(otpID)},
		ReceivedAt:           timestamppb.New(now.UTC()),
		ExpiresAt:            timestamppb.New(otp.expiresAt.UTC()),
	}
}
