// armada-hevc-publisher is Armada's Linux H.265 publishing sidecar.
//
// Chromium on Linux can receive H.265 but does not expose a WebRTC H.265
// encoder. Armada therefore captures through Chromium's normal screen picker,
// sends BGRA frames to FFmpeg/VA-API in the Electron main process, and pipes
// the resulting Annex-B access units here. This process joins with a second,
// broker-minted identity and publishes one E2EE screen-share track.
package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/livekit/server-sdk-go/v2/e2ee/types"
	"github.com/pion/webrtc/v4"
)

const (
	configFD     = 3
	keyIndex     = uint32(0)
	frameKeySalt = "LKFrameEncryptionKey"
	hkdfInfoSize = 128
)

type config struct {
	URL         string `json:"url"`
	Token       string `json:"token"`
	KeyMaterial string `json:"keyMaterial"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	FrameRate   int    `json:"frameRate"`
}

type countingReadCloser struct {
	io.ReadCloser
	bytes atomic.Uint64
}

func (r *countingReadCloser) Read(buffer []byte) (int, error) {
	n, err := r.ReadCloser.Read(buffer)
	r.bytes.Add(uint64(n))
	return n, err
}

// concordKeyProvider deliberately accepts a 32-byte AES key. LiveKit's Go
// helper provider fixes its raw key at 16 bytes for the default AES-128
// profile, while CORD-07 requires AES-256. The frame encryptor itself delegates
// to crypto/aes and is fully compatible with either valid AES key size.
type concordKeyProvider struct {
	key []byte
}

var _ types.KeyProvider = (*concordKeyProvider)(nil)

func (p *concordKeyProvider) GetKey(index uint32) ([]byte, error) {
	if index != keyIndex {
		return nil, fmt.Errorf("no frame key at index %d", index)
	}
	return append([]byte(nil), p.key...), nil
}

func (*concordKeyProvider) CurrentKeyIndex() uint32 { return keyIndex }

func hkdfSHA256(ikm, salt, info []byte, length int) ([]byte, error) {
	if length <= 0 || length > sha256.Size*255 {
		return nil, fmt.Errorf("invalid HKDF output length %d", length)
	}
	extract := hmac.New(sha256.New, salt)
	_, _ = extract.Write(ikm)
	prk := extract.Sum(nil)

	result := make([]byte, 0, length)
	previous := []byte(nil)
	for counter := byte(1); len(result) < length; counter++ {
		expand := hmac.New(sha256.New, prk)
		_, _ = expand.Write(previous)
		_, _ = expand.Write(info)
		_, _ = expand.Write([]byte{counter})
		previous = expand.Sum(nil)
		result = append(result, previous...)
	}
	return result[:length], nil
}

func deriveFrameKey(material []byte) ([]byte, error) {
	if len(material) != 32 {
		return nil, fmt.Errorf("Concord sender material must be 32 bytes, got %d", len(material))
	}
	return hkdfSHA256(material, []byte(frameKeySalt), make([]byte, hkdfInfoSize), 32)
}

func readConfig() (config, error) {
	file := os.NewFile(configFD, "armada-hevc-config")
	if file == nil {
		return config{}, errors.New("configuration pipe is unavailable")
	}
	defer file.Close()
	var cfg config
	decoder := json.NewDecoder(io.LimitReader(file, 64*1024))
	if err := decoder.Decode(&cfg); err != nil {
		return config{}, fmt.Errorf("decode configuration: %w", err)
	}
	if cfg.URL == "" || cfg.Token == "" || cfg.KeyMaterial == "" {
		return config{}, errors.New("url, token, and keyMaterial are required")
	}
	if cfg.Width < 16 || cfg.Height < 16 || cfg.Width > 7680 || cfg.Height > 4320 {
		return config{}, fmt.Errorf("invalid video dimensions %dx%d", cfg.Width, cfg.Height)
	}
	if cfg.Width%2 != 0 || cfg.Height%2 != 0 {
		return config{}, errors.New("H.265 video dimensions must be even")
	}
	if cfg.FrameRate < 1 || cfg.FrameRate > 120 {
		return config{}, fmt.Errorf("invalid frame rate %d", cfg.FrameRate)
	}
	return cfg, nil
}

func status(state string, detail any) {
	message := map[string]any{"state": state}
	if detail != nil {
		message["detail"] = detail
	}
	encoded, _ := json.Marshal(message)
	_, _ = fmt.Fprintln(os.Stderr, string(encoded))
}

func run(ctx context.Context, cfg config) error {
	material, err := base64.StdEncoding.DecodeString(cfg.KeyMaterial)
	if err != nil {
		return fmt.Errorf("decode sender material: %w", err)
	}
	frameKey, err := deriveFrameKey(material)
	if err != nil {
		return err
	}
	provider := &concordKeyProvider{key: frameKey}
	encryptor, err := lksdk.NewFrameEncryptor(provider, lksdk.CodecH265)
	if err != nil {
		return fmt.Errorf("create H.265 frame encryptor: %w", err)
	}

	writeComplete := make(chan struct{})
	input := &countingReadCloser{ReadCloser: os.Stdin}
	track, err := lksdk.NewLocalReaderTrack(
		input,
		webrtc.MimeTypeH265,
		lksdk.ReaderTrackWithFrameDuration(time.Second/time.Duration(cfg.FrameRate)),
		lksdk.ReaderTrackWithOnWriteComplete(func() { close(writeComplete) }),
		lksdk.ReaderTrackWithSampleOptions(lksdk.WithFrameEncryptor(encryptor)),
	)
	if err != nil {
		return fmt.Errorf("create H.265 track: %w", err)
	}

	room, err := lksdk.ConnectToRoomWithToken(
		cfg.URL,
		cfg.Token,
		&lksdk.RoomCallback{},
		lksdk.WithAutoSubscribe(false),
	)
	if err != nil {
		return fmt.Errorf("connect to LiveKit: %w", err)
	}
	defer room.Disconnect()

	publication, err := room.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{
		Name:        "Armada H.265 screen share",
		Source:      livekit.TrackSource_SCREEN_SHARE,
		VideoWidth:  cfg.Width,
		VideoHeight: cfg.Height,
		Encryption:  livekit.Encryption_GCM,
	})
	if err != nil {
		return fmt.Errorf("publish H.265 screen share: %w", err)
	}
	status("published", map[string]any{
		"trackSid":  publication.SID(),
		"width":     cfg.Width,
		"height":    cfg.Height,
		"frameRate": cfg.FrameRate,
	})

	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	var previousBytes uint64
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-writeComplete:
			return nil
		case <-ticker.C:
			total := input.bytes.Load()
			bytesPerSecond := total - previousBytes
			previousBytes = total
			status("progress", map[string]any{
				"encodedBytes":   total,
				"encodedBitrate": bytesPerSecond * 8,
			})
		}
	}
}

func main() {
	cfg, err := readConfig()
	if err != nil {
		status("error", err.Error())
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, cfg); err != nil {
		status("error", err.Error())
		os.Exit(1)
	}
	status("stopped", nil)
}
