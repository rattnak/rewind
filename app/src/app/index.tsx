import { useCameraPermissions } from 'expo-camera';
import { useIsFocused } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { CameraStage, type CameraStageHandle } from '@/components/camera-stage';
import { CartChip } from '@/components/cart-chip';
import { FocusFrame, type FrameTone } from '@/components/focus-frame';
import { HealthBanner } from '@/components/health-banner';
import { HistorySheet } from '@/components/history-sheet';
import { HomePanels } from '@/components/home-panels';
import { OnboardingFlow } from '@/components/onboarding-flow';
import { ProfileButton } from '@/components/profile-button';
import { ProfileSheet } from '@/components/profile-sheet';
import { TranscriptPill } from '@/components/transcript-pill';
import { OrbGlow, useDomeHeight, VoiceOrb } from '@/components/voice-orb';
import { Layout, MaxContentWidth, Spacing } from '@/constants/theme';
import { useA11y } from '@/lib/a11y';
import { Phrases } from '@/lib/phrases';
import { useProfile } from '@/lib/profile';
import { useResponsive } from '@/lib/responsive';
import { inflate, photoToScreen, StageContext, type Rect } from '@/lib/stage';
import { STEADY_MS, useSteadiness } from '@/lib/steady';
import { useAgent } from '@/state/agent';

/** A barcode sighting older than this no longer moves the focus corners. */
const BARCODE_LIVE_MS = 800;
/** Barcode events arrive many times a second; update the corners at most this often. */
const BARCODE_THROTTLE_MS = 150;
/** Payment-card aspect ratio (ISO/IEC 7810 ID-1), for the onboarding card guide. */
const CARD_RATIO = 1.586;

/**
 * The one camera screen. Back to front:
 *   live camera (tap anywhere to scan)
 *   → focus corners on the item
 *   → the pop-up card, pointing at the item
 *   → top bar: cart chip (left), profile (right), caption pill below
 *   → voice orb with its glow (bottom)
 *
 * Scanning is automatic: holding the phone steady on a new item for about a
 * second takes one photo (approved change to tech spec 1.3). Tapping anywhere
 * still scans; voice works as before.
 */
export default function Home() {
  const { palette } = useA11y();
  const { profile, loaded } = useProfile();
  const { state, beginCapture, scanFrame, sayLocal, startCheckin } = useAgent();
  const [camera, requestCamera] = useCameraPermissions();
  const focused = useIsFocused();
  const { width, height } = useWindowDimensions();
  const r = useResponsive();
  const stage = useRef<CameraStageHandle>(null);

  const onboarding = loaded && !profile.onboarded;
  const addingCard = state.view === 'add_card';
  const busy = state.phase === 'capturing' || state.phase === 'awaiting_scan';
  const granted = !!camera?.granted;

  // --- layout: the free area between the top bar and the orb -----------------
  // Free area for the answer card: below the top block (cart/profile row and
  // transcript), above the dome, with a standard 16 pt gap to each.
  const insets = useSafeAreaInsets();
  const [rowBottom, setRowBottom] = useState(insets.top + 80);
  const domeTop = height - useDomeHeight();
  const area: Rect = useMemo(
    () => ({ x: 0, y: rowBottom + Layout.stack, w: width, h: Math.max(0, domeTop - rowBottom - Layout.stack * 2) }),
    [rowBottom, domeTop, width],
  );

  // --- store check-in: once per launch, after onboarding (position used once, never stored) ----
  const checkedIn = useRef(false);
  useEffect(() => {
    if (!loaded || onboarding || !focused || checkedIn.current) return;
    checkedIn.current = true;
    // No cleanup: the flag is already set, so a re-render must not cancel the one check-in.
    setTimeout(() => void startCheckin(), 1200);
  }, [loaded, onboarding, focused, startCheckin]);

  // --- onboarding card capture hooks into tap-anywhere ------------------------
  const onboardingCapture = useRef<(() => void) | null>(null);
  const [cardCapture, setCardCapture] = useState(false);
  const registerCapture = useCallback((fn: (() => void) | null) => {
    onboardingCapture.current = fn;
    setCardCapture(!!fn);
  }, []);

  // --- live barcode (on-device) -----------------------------------------------
  const [barcode, setBarcode] = useState<{ code: string; box: Rect | null; at: number } | null>(null);
  const lastBarcodeUpdate = useRef(0);
  const onBarcode = useCallback((code: string, box: Rect | null) => {
    const now = Date.now();
    if (now - lastBarcodeUpdate.current < BARCODE_THROTTLE_MS) return;
    lastBarcodeUpdate.current = now;
    setBarcode({ code, box, at: now });
  }, []);
  useEffect(() => {
    if (!barcode) return;
    const t = setTimeout(() => setBarcode(null), BARCODE_LIVE_MS);
    return () => clearTimeout(t);
  }, [barcode]);

  // --- scanning ---------------------------------------------------------------
  const scan = useCallback(async () => {
    if (onboardingCapture.current) {
      onboardingCapture.current();
      return;
    }
    if (onboarding || addingCard || busy) return;
    if (!granted) {
      sayLocal(Phrases.cameraDenied);
      return;
    }
    beginCapture();
    const shot = await stage.current?.capture();
    if (!shot) {
      sayLocal(Phrases.captureFailed);
      return;
    }
    await scanFrame(shot.uri, shot.barcode, shot.discard, { width: shot.width, height: shot.height });
  }, [onboarding, addingCard, busy, granted, beginCapture, scanFrame, sayLocal]);

  // Auto-capture when steady on a new item. Moving the phone or a new barcode re-arms it. The
  // motion sensor keeps running while a result is showing, so moving on to the next item counts
  // even if the last question was never answered by voice; a finished or expired question (no live
  // prompt) no longer blocks the next scan.
  const watching =
    !onboarding &&
    !addingCard &&
    granted &&
    focused &&
    state.view === 'camera' &&
    !state.declined &&
    !state.receipt;
  // In conversation mode the phase is usually 'listening' (the mic stays open), so allow
  // auto-capture there too — the scan interrupts the listen, which is fine.
  const autoReady = watching && (state.phase === 'idle' || (state.conversing && state.phase === 'listening')) && !state.livePrompt;
  // Card steps (onboarding and Add a card): the same steadiness check takes the card photo once the
  // agent has finished the instruction and the phone is held still on the card. Tap still works.
  const cardAutoReady = cardCapture && granted && focused && (state.phase === 'idle' || (state.conversing && state.phase === 'listening'));
  const { steady, moveCount, available } = useSteadiness(watching || cardAutoReady);
  const armed = useRef(true);
  const cardArmed = useRef(true);
  // Whether the sensor has had time to restart after a step change. A ref gates
  // the same-render check (effects see ref changes synchronously); the counter
  // state triggers a re-run when the timer fires.
  const cardReadyRef = useRef(true);
  const [cardReadyTick, setCardReadyTick] = useState(0);
  // Movement re-arms immediately (the user moved to a new card).
  useEffect(() => { cardArmed.current = true; }, [moveCount]);
  // A new card step delays arming so the steadiness sensor has time to restart.
  useEffect(() => {
    cardArmed.current = true;
    cardReadyRef.current = false;
    const t = setTimeout(() => {
      cardReadyRef.current = true;
      setCardReadyTick((n) => n + 1); // bump to re-trigger the auto-capture effect
    }, STEADY_MS + 200);
    return () => clearTimeout(t);
  }, [cardCapture]);
  useEffect(() => {
    if (!cardAutoReady || !available || !steady || !cardArmed.current || !cardReadyRef.current) return;
    cardArmed.current = false;
    onboardingCapture.current?.();
    // cardReadyTick is in deps only to re-run the effect when the delay timer fires;
    // the actual gate uses cardReadyRef for synchronous same-render blocking.
  }, [cardAutoReady, available, steady, cardReadyTick]);
  const lastScannedCode = useRef<string | null>(null);
  useEffect(() => {
    armed.current = true;
  }, [moveCount]);
  useEffect(() => {
    if (barcode && barcode.code !== lastScannedCode.current) armed.current = true;
  }, [barcode]);
  useEffect(() => {
    if (!autoReady || !available || !steady || !armed.current) return;
    armed.current = false;
    lastScannedCode.current = barcode?.code ?? null;
    void scan();
  }, [autoReady, available, steady, barcode, scan]);

  // --- focus corners ----------------------------------------------------------
  const scanShowing = !!state.lastScan && state.view === 'camera' && !state.declined && !state.receipt;
  const vision = state.lastScan?.scan.item_bbox;
  let itemBox: Rect | null = null;
  let tone: FrameTone = 'guide';
  if (scanShowing && vision && state.lastPhoto) {
    itemBox = photoToScreen(vision, state.lastPhoto, { width, height });
    tone = 'locked';
  } else if (barcode?.box && !scanShowing) {
    itemBox = inflate(barcode.box, 2.4, { width, height });
  }
  // Onboarding and add-a-card frame a payment-card shape; the pop-ups point at it.
  const cardMode = onboarding || addingCard || cardCapture;
  const guideW = Math.min(width * (cardMode ? 0.82 : 0.62), MaxContentWidth);
  const guideH = cardMode ? guideW / CARD_RATIO : guideW * 1.1;
  // The camera view is what's left between the card (or the top block) and the
  // dome. The focus corners live there; if it is too small for a proper frame,
  // they hide until the card closes (the card is describing the item).
  const [card, setCard] = useState<Rect | null>(null);
  const camTop = card ? card.y + card.h + Layout.stack : area.y;
  const camBottom = domeTop - Layout.stack;
  const camH = Math.max(0, camBottom - camTop);
  const guideFitH = Math.min(guideH, camH);
  // A card frame shrinks evenly when space is tight, so the corners stay card-shaped.
  const guideFitW = cardMode && guideH > camH ? guideFitH * CARD_RATIO : guideW;
  const guide: Rect = {
    x: (width - guideFitW) / 2,
    y: camTop + Math.max(0, (camH - guideFitH) / 2),
    w: guideFitW,
    h: guideFitH,
  };
  const MIN_FRAME = 140;
  const fitFrame = (r: Rect): Rect | null => {
    const top = Math.max(r.y, camTop);
    const bottom = Math.min(r.y + r.h, camBottom);
    const h = bottom - top;
    return h >= MIN_FRAME ? { ...r, y: top, h } : null;
  };

  const showFrame =
    granted && (cardMode || (state.view === 'camera' && !state.declined && !state.receipt));

  const frameBox = fitFrame(itemBox ?? guide);
  // The corners lock (solid) while the phone is held still on the card, just before the photo.
  const cardLocked = cardAutoReady && available && steady;

  // The status pill always states the real next step.
  const answerPending = scanShowing && state.lastScan?.scan.state !== 'unresolved' && !!state.lastScan?.recommendation;
  const hint = answerPending
    ? 'Say yes or no, or tap a button'
    : cardAutoReady
      ? available
        ? 'Hold the card steady in the corners'
        : 'Tap the screen to take the photo'
      : autoReady
      ? available
        ? 'Hold steady on an item'
        : 'Tap the screen to scan'
      : null;

  return (
    <View style={[styles.root, { backgroundColor: palette.bg }]}>
      <CameraStage ref={stage} granted={granted} active={focused} onBarcode={onBarcode} />

      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={() => void scan()}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={
          cardCapture
            ? 'Camera. Tap anywhere to take the photo.'
            : 'Camera. Tap anywhere to scan the item in front of the phone.'
        }
        accessibilityState={{ busy }}
      />

      {/* The dome sits behind everything that follows, so it never draws over a pop-up. */}
      <OrbGlow />

      {showFrame && frameBox ? <FocusFrame box={frameBox} tone={itemBox ? tone : cardLocked ? 'locked' : 'guide'} /> : null}

      <StageContext.Provider
        value={{ itemBox: cardMode ? guide : scanShowing ? itemBox : null, area, reportCard: setCard }}>
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          {onboarding ? (
            <OnboardingFlow
              camera={camera}
              requestCamera={requestCamera}
              registerCapture={registerCapture}
              capture={async () => (await stage.current?.capture()) ?? null}
            />
          ) : addingCard ? (
            // Business spec 6.4 / 20.6: link another card, reusing the onboarding card steps.
            <AddCardFlow
              camera={camera}
              requestCamera={requestCamera}
              registerCapture={registerCapture}
              capture={async () => (await stage.current?.capture()) ?? null}
            />
          ) : state.view === 'profile' ? (
            <ProfileSheet />
          ) : (
            <HomePanels />
          )}
        </View>
      </StageContext.Provider>

      <SafeAreaView
        edges={['top', 'left', 'right']}
        style={styles.top}
        pointerEvents="box-none"
        onLayout={(e) => setRowBottom(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}>
        <View style={[styles.topRow, { width: r.contentWidth }]} pointerEvents="box-none">
          {onboarding ? <View /> : <CartChip />}
          <ProfileButton />
        </View>
        <View style={[styles.pillRow, { width: r.contentWidth }]} pointerEvents="box-none">
          <TranscriptPill />
        </View>
        <HealthBanner />
      </SafeAreaView>

      {/* Purchase history is a full page: it sits above the cart chip and profile button. */}
      {state.view === 'history' && !onboarding && !addingCard ? <HistorySheet /> : null}

      <View style={styles.bottom} pointerEvents="box-none">
        <VoiceOrb hint={hint} historyEnabled={!onboarding && !addingCard} />
      </View>
    </View>
  );
}

function AddCardFlow(props: Omit<Parameters<typeof OnboardingFlow>[0], 'startAt' | 'onDone'>) {
  const { showView } = useAgent();
  return <OnboardingFlow {...props} startAt="payment" onDone={() => showView('camera')} />;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  top: { position: 'absolute', top: 0, left: 0, right: 0 },
  // Rows sit in the centered content column (Layout.margin on phones, max 640 pt on tablets).
  topRow: {
    alignSelf: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: Spacing.sm,
    gap: Layout.stack,
  },
  pillRow: { alignSelf: 'center', flexDirection: 'row', paddingTop: Layout.stack },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0 },
});
