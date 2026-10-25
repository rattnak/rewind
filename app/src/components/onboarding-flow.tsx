import { File as FsFile } from 'expo-file-system';
import { requestRecordingPermissionsAsync, getRecordingPermissionsAsync } from 'expo-audio';
import type { PermissionResponse } from 'expo-camera';
import { useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet, TextInput, View } from 'react-native';

import { BigButton } from '@/components/big-button';
import { ButtonPair, ButtonRow } from '@/components/button-pair';
import type { Capture } from '@/components/camera-stage';
import { CardArt } from '@/components/card-art';
import { Notice } from '@/components/icon';
import { InfoPanel, PanelActions, PanelText } from '@/components/info-panel';
import { InsuranceSummary } from '@/components/insurance-summary';
import { Radius, Spacing, Target, Type } from '@/constants/theme';
import { useA11y } from '@/lib/a11y';
import * as api from '@/lib/api';
import type { Card, CardNetwork, CardScanResult } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { Onboarding as Say } from '@/lib/phrases';
import { DEMO_MODE, DEMO_PHONE, useProfile, type Insurance } from '@/lib/profile';
import { useAgent } from '@/state/agent';

type Step =
  | 'perm_camera'
  | 'perm_mic'
  | 'phone'
  | 'insurance'
  | 'name_confirm'
  | 'name_type'
  | 'insurance_confirm'
  | 'payment'
  | 'payment_type'
  | 'payment_confirm'
  | 'payment_more'
  | 'done';

type Payment = NonNullable<CardScanResult['payment']>;

const YES = /\b(yes|yeah|yep|correct|right|sure|ok|okay|continue)\b/i;
const NO = /\b(no|nope|wrong|not)\b/i;

const NETWORK_NAME: Record<CardNetwork, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
  other: 'card',
};

function spokenCard(p: Payment): string {
  // HSA, FSA, and everyday cards are all Visa cards; say the network, then the type.
  const brand = p.network && p.network !== 'other' ? `${NETWORK_NAME[p.network]} ` : '';
  if (p.card_type === 'hsa') return `a ${brand}HSA card`;
  if (p.card_type === 'fsa') return `a ${brand}FSA card`;
  return `a ${brand}${p.funding ?? 'credit or debit'} card`;
}

function nicknameFor(type: Card['type'], network: CardNetwork | null, kind?: 'credit' | 'debit'): string {
  if (type === 'hsa') return 'HSA card';
  if (type === 'fsa') return 'FSA card';
  const brand = network && network !== 'other' ? NETWORK_NAME[network] : 'Card';
  return `${brand} ${kind ?? 'credit'}`;
}

function splitName(typed: string): { first: string; last: string } | null {
  const words = typed
    .replace(/[^A-Za-z\u00C0-\u024F\s'-]/g, '') // letters incl. accents; no \p{} (Hermes)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
  if (!words.length) return null;
  return { first: words[0], last: words.slice(1).join(' ') };
}

/**
 * Frame 1: voice-guided first launch. Every step is spoken, captioned, and has
 * tap buttons, so it works by voice, by touch, or with a screen reader.
 * The camera stays live underneath so cards can be framed.
 *
 * Rewind never asks for the user's name. It reads the name from the insurance
 * card and clarifies it in a pop-up ("Your name is Alex Rivera. Is that
 * right?"); a wrong name can be fixed by scanning again or typing it.
 */
export function OnboardingFlow({
  camera,
  requestCamera,
  registerCapture,
  capture,
  startAt,
  onDone,
}: {
  camera: PermissionResponse | null;
  requestCamera: () => Promise<PermissionResponse>;
  /** Lets a tap anywhere on the camera take the card photo. */
  registerCapture: (fn: (() => void) | null) => void;
  capture: () => Promise<Capture | null>;
  /** Add-a-card mode: start at card capture and call onDone instead of finishing onboarding. */
  startAt?: 'payment';
  onDone?: () => void;
}) {
  const { sayLocal, sayThen, setListenHandler, refreshCards, quietMic } = useAgent();
  const { screenReaderOn } = useA11y();
  const { profile, update } = useProfile();
  const [chosen, setStep] = useState<Step | null>(null);
  // The first step depends on whether camera permission is already granted.
  const step: Step | null =
    chosen ?? startAt ?? (camera ? (camera.granted ? 'perm_mic' : 'perm_camera') : null);
  // During onboarding the first card asked for is the HSA/FSA card; when adding later it can be any card.
  const firstCard = !startAt;
  const [name, setName] = useState<{ first: string; last: string } | null>(null);
  const [typed, setTyped] = useState('');
  const [insurance, setInsurance] = useState<Insurance | null>(null);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [debitOrCredit, setDebitOrCredit] = useState<'credit' | 'debit' | undefined>();
  const [cardsAdded, setCardsAdded] = useState(0);
  const [reading, setReading] = useState(false);
  const busy = useRef(false);

  // Skip the mic step when already granted.
  useEffect(() => {
    if (step !== 'perm_mic') return;
    getRecordingPermissionsAsync().then((p) => p.granted && setStep('phone'));
  }, [step]);

  // Speak each step as it appears.
  useEffect(() => {
    if (!step) return;
    if (step === 'done' && onDone) {
      onDone();
      return;
    }
    const first = name?.first ?? profile.firstName;
    const line: Partial<Record<Step, string>> = {
      perm_camera: Say.cameraWhy,
      perm_mic: Say.micWhy,
      phone: DEMO_MODE ? Say.phoneDemo(DEMO_PHONE) : undefined,
      name_confirm: name ? Say.confirmCardName(`${name.first} ${name.last}`.trim()) : undefined,
      name_type: Say.typeName,
      insurance: Say.askInsurance,
      insurance_confirm: insurance
        ? Say.confirmInsurance(insurance.insurer_name, insurance.plan_name, !!insurance.rx)
        : undefined,
      payment: Say.askPayment(cardsAdded === 0 && firstCard),
      payment_type: Say.askCardType,
      payment_confirm: payment ? Say.confirmCard(spokenCard(payment), payment.last4) : undefined,
      done: Say.done(first),
    };
    const text = line[step];
    if (step === 'done' && text && !screenReaderOn) {
      // The last card says everything it has to say, then closes by itself (the same as Start shopping).
      sayThen(text, finish);
    } else if (text) {
      sayLocal(text);
    }
    // Only on step change; the data a line uses is set before the step changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // What a spoken answer means at each step.
  useEffect(() => {
    if (!step) return;
    const yesNo = (onYes: () => void, onNo: () => void) => (t: string) =>
      YES.test(t) ? onYes() : NO.test(t) ? onNo() : sayLocal("Please say yes or no.");
    const handlers: Partial<Record<Step, [api.SttHint | undefined, (t: string) => void]>> = {
      name_confirm: ['yes_no', yesNo(() => saveName(name), () => setStep('name_type'))],
      phone: ['yes_no', () => setStep('insurance')],
      insurance_confirm: ['yes_no', yesNo(confirmInsurance, () => setStep('insurance'))],
      payment_type: [
        'card_type',
        (t) => {
          const s = t.toLowerCase();
          if (s.includes('hsa')) chooseType('hsa');
          else if (s.includes('fsa')) chooseType('fsa');
          else if (s.includes('debit')) chooseType('general', 'debit');
          else if (s.includes('credit') || s.includes('regular') || s.includes('visa')) chooseType('general', 'credit');
          else sayLocal(Say.askCardType);
        },
      ],
      payment_confirm: ['yes_no', yesNo(confirmPayment, () => setStep('payment'))],
      payment_more: ['yes_no', yesNo(() => setStep('payment'), () => setStep('done'))],
      // Last card: the shopper tapped the round button to interrupt and spoke. Whatever they said
      // (start shopping, yes, anything), the card just closes.
      done: [undefined, () => finish()],
    };
    const h = handlers[step];
    setListenHandler(h?.[0], h?.[1] ?? null);
    registerCapture(step === 'insurance' || step === 'payment' ? () => void takeCard() : null);
    return () => {
      setListenHandler(undefined, null);
      registerCapture(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, name, insurance, payment, cardsAdded]);

  // --- step actions ---------------------------------------------------------

  /** Save the confirmed (or typed) name, thank the user by name, then show the rest of the card. */
  function saveName(n: { first: string; last: string } | null) {
    if (!n) return;
    setName(n);
    update({ firstName: n.first, lastName: n.last });
    sayLocal(Say.greet(n.first));
    setStep(insurance ? 'insurance_confirm' : 'payment');
  }

  function onTypedName() {
    const n = splitName(typed);
    if (n) saveName(n);
  }

  function verifyPhone() {
    if (DEMO_MODE) update({ phone: DEMO_PHONE, phoneVerified: true });
    setStep('insurance');
  }

  async function takeCard() {
    if (busy.current) return;
    busy.current = true;
    setReading(true);
    quietMic();
    haptic.capture();
    const kind = step === 'insurance' ? 'insurance' : 'payment';
    const shot = await capture();
    try {
      if (!shot) throw new Error('no capture');
      const res = await api.scanCard(shot.uri, kind);
      if (res.state === 'unclear') {
        let size = '';
        try {
          size = `, photo ${shot.width}x${shot.height} ${Math.round((new FsFile(shot.uri).size ?? 0) / 1024)} KB`;
        } catch {
          // size is only for the log
        }
        console.warn(`[card-scan] backend could not read the card (${res.reason ?? 'unclear'}${size})`);
        sayLocal(res.framing_hint ?? Say.unclear);
        return;
      }
      if (kind === 'insurance' && res.insurance) {
        setInsurance(res.insurance);
        const first = res.insurance.member_first_name?.trim();
        if (first) {
          setName({ first, last: res.insurance.member_last_name?.trim() ?? '' });
          setStep('name_confirm');
        } else {
          // No name printed or readable: let the user type it (optional).
          setStep('name_type');
        }
      } else if (kind === 'payment' && res.payment) {
        setPayment(res.payment);
        setDebitOrCredit(res.payment.funding ?? undefined);
        // Ask the card type only when the card face doesn't say it.
        const known = res.payment.card_type && (res.payment.card_type !== 'general' || res.payment.funding);
        setStep(known ? 'payment_confirm' : 'payment_type');
      } else {
        sayLocal(Say.unclear);
      }
    } catch (e) {
      // Logged so a failure on a real phone shows in the Metro terminal.
      console.warn('[card-scan] failed:', e instanceof api.ApiError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : e);
      haptic.error();
      sayLocal(e instanceof api.ApiError && e.speech ? e.speech : Say.unclear);
    } finally {
      shot?.discard(); // card images are never retained
      busy.current = false;
      setReading(false);
    }
  }

  function confirmInsurance() {
    update({ insurance });
    setStep('payment');
  }

  function chooseType(type: Card['type'], kind?: 'credit' | 'debit') {
    if (!payment) return;
    setPayment({ ...payment, card_type: type });
    setDebitOrCredit(kind);
    setStep('payment_confirm');
  }

  async function confirmPayment() {
    if (!payment?.card_type) return;
    try {
      await api.linkCard({
        type: payment.card_type,
        nickname: nicknameFor(payment.card_type, payment.network, debitOrCredit),
        last4: payment.last4,
        network: payment.network,
      });
      await refreshCards();
      setCardsAdded((n) => n + 1);
      sayLocal(Say.cardAdded(nicknameFor(payment.card_type, payment.network, debitOrCredit)));
      setStep('payment_more');
    } catch (e) {
      haptic.error();
      sayLocal(e instanceof api.ApiError && e.speech ? e.speech : Say.unclear);
    }
  }

  function finish() {
    update({ onboarded: true });
  }

  // --- render ---------------------------------------------------------------

  if (!step) return null;

  const yesNoButtons = (onYes: () => void, onNo: () => void, noA11y = 'No, try again') => (
    <PanelActions>
      <ButtonPair yesA11y="Yes, that's right" noA11y={noA11y} onYes={onYes} onNo={onNo} />
    </PanelActions>
  );

  const step1of = (n: number) => <PanelText kind="small" muted>{`Step ${n} of 4`}</PanelText>;

  switch (step) {
    case 'perm_camera':
      return (
        <InfoPanel title="Camera">
          <PanelText>{Say.cameraWhy}</PanelText>
          {camera && !camera.granted && !camera.canAskAgain ? (
            <>
              <PanelText>Camera access is off for Rewind. You can turn it on in your phone settings.</PanelText>
              <PanelActions>
                <BigButton label="Open phone settings" variant="primary" size="primary" onPress={() => Linking.openSettings()} />
                <BigButton label="Continue without camera" onPress={() => setStep('perm_mic')} />
              </PanelActions>
            </>
          ) : (
            <PanelActions>
            <BigButton
              label="Allow camera"
              icon="camera"
              variant="primary"
              size="primary"
              onPress={async () => {
                await requestCamera();
                setStep('perm_mic');
              }}
            />
            </PanelActions>
          )}
        </InfoPanel>
      );

    case 'perm_mic':
      return (
        <InfoPanel title="Microphone">
          <PanelText>{Say.micWhy}</PanelText>
          <PanelActions>
          <BigButton
            label="Allow microphone"
            icon="mic"
            variant="primary"
            size="primary"
            onPress={async () => {
              await requestRecordingPermissionsAsync();
              setStep('phone');
            }}
          />
          <BigButton label="Use buttons only" onPress={() => setStep('phone')} />
          </PanelActions>
        </InfoPanel>
      );

    case 'phone':
      return (
        <InfoPanel title="Welcome to Rewind">
          {step1of(1)}
          <Notice icon="verified" color="eligible" kind="label">
            This phone is verified.
          </Notice>
          <PanelText kind="small" muted>
            {`Prototype: verified with the demo number ${DEMO_PHONE}. No text message is sent.`}
          </PanelText>
          <PanelActions>
          <BigButton label="Continue" icon="next" variant="primary" size="primary" onPress={verifyPhone} />
          </PanelActions>
        </InfoPanel>
      );

    case 'insurance':
      return (
        // Compact on purpose: the card corners need the space below it (the agent speaks the full instructions).
        <InfoPanel title="Insurance card · step 2 of 4">
          <PanelText>Hold it flat in the corners and keep still.</PanelText>
          <PanelActions>
            <ButtonRow>
              <BigButton label={reading ? 'Reading…' : 'Take photo'} icon="camera" variant="primary" disabled={reading} onPress={() => void takeCard()} stretch />
              <BigButton label="Skip" accessibilityLabel="Skip for now" variant="secondary" onPress={() => setStep('payment')} stretch />
            </ButtonRow>
          </PanelActions>
        </InfoPanel>
      );

    case 'name_confirm':
      // Same compact pop-up as the prescription read-back, pointing at the card.
      return (
        <InfoPanel label="Name from your insurance card">
          <PanelText kind="small" muted>
            From your insurance card · is this your name?
          </PanelText>
          <PanelText kind="title">{`${name?.first ?? ''} ${name?.last ?? ''}`.trim()}</PanelText>
          <PanelActions>
          <View style={styles.row}>
            <View style={styles.grow}>
              <BigButton label="Yes" icon="check" variant="primary" onPress={() => saveName(name)} />
            </View>
            <View style={styles.grow}>
              <BigButton label="No" icon="close" onPress={() => setStep('name_type')} />
            </View>
          </View>
          </PanelActions>
        </InfoPanel>
      );

    case 'name_type':
      return (
        <InfoPanel title="What’s your name?">
          <PanelText kind="small" muted>
            Type it, or scan the card again.
          </PanelText>
          <NameInput value={typed} onChange={setTyped} onSubmit={onTypedName} />
          <PanelActions>
          <View style={styles.row}>
            <View style={styles.grow}>
              <BigButton label="Save" icon="check" variant="primary" onPress={onTypedName} disabled={!typed.trim()} />
            </View>
            <View style={styles.grow}>
              <BigButton label="Scan again" icon="retry" onPress={() => setStep('insurance')} />
            </View>
          </View>
          </PanelActions>
        </InfoPanel>
      );

    case 'insurance_confirm':
      return (
        <InfoPanel title="Is this your insurance?">
          {step1of(2)}
          {insurance ? <InsuranceSummary card={insurance} /> : null}
          {yesNoButtons(confirmInsurance, () => setStep('insurance'))}
        </InfoPanel>
      );

    case 'payment':
      return (
        // Compact on purpose: the card corners need the space below it (the agent speaks the full instructions).
        <InfoPanel
          title={`${cardsAdded === 0 && firstCard ? 'HSA or FSA Visa card' : 'Everyday Visa card'}${startAt ? '' : ' · step 3 of 4'}`}>
          <PanelText>Hold it flat in the corners and keep still.</PanelText>
          <PanelActions>
            <ButtonRow>
              <BigButton label={reading ? 'Reading…' : 'Take photo'} icon="camera" variant="primary" disabled={reading} onPress={() => void takeCard()} stretch />
              <BigButton
                label={startAt ? 'Cancel' : cardsAdded === 0 ? 'Skip' : 'Done'}
                accessibilityLabel={startAt ? 'Cancel' : cardsAdded === 0 ? 'Skip for now' : "I'm done adding cards"}
                variant="secondary"
                onPress={() => setStep('done')}
                stretch
              />
            </ButtonRow>
          </PanelActions>
        </InfoPanel>
      );

    case 'payment_type':
      return (
        <InfoPanel title="What kind of card is this?">
          {step1of(3)}
          <PanelActions>
          <View style={styles.buttons}>
            <BigButton label="HSA card" variant="primary" onPress={() => chooseType('hsa')} />
            <BigButton label="FSA card" variant="primary" onPress={() => chooseType('fsa')} />
            <BigButton label="Credit card" onPress={() => chooseType('general', 'credit')} />
            <BigButton label="Debit card" onPress={() => chooseType('general', 'debit')} />
          </View>
          </PanelActions>
        </InfoPanel>
      );

    case 'payment_confirm':
      return (
        <InfoPanel title="Is this your card?">
          {step1of(3)}
          {payment?.card_type ? (
            <View
              accessible
              accessibilityLabel={`${nicknameFor(payment.card_type, payment.network, debitOrCredit)}${
                payment.last4 ? ` ending in ${payment.last4.split('').join(' ')}` : ''
              }`}>
              <CardArt
                type={payment.card_type}
                nickname={nicknameFor(payment.card_type, payment.network, debitOrCredit)}
                last4={payment.last4}
              />
            </View>
          ) : null}
          <PanelText kind="small" muted>
            Rewind keeps only the last 4 digits.
          </PanelText>
          {yesNoButtons(() => void confirmPayment(), () => setStep('payment'))}
        </InfoPanel>
      );

    case 'payment_more':
      return (
        <InfoPanel title="Card added">
          {step1of(3)}
          <PanelText>Do you want to add another card?</PanelText>
          <PanelActions>
          <View style={styles.buttons}>
            <BigButton label="Add another card" icon="add" variant="primary" size="primary" onPress={() => setStep('payment')} />
            <BigButton label="No, I'm done" onPress={() => setStep('done')} />
          </View>
          </PanelActions>
        </InfoPanel>
      );

    case 'done':
      return (
        <InfoPanel title={`You're all set, ${profile.firstName || name?.first || ''}`}>
          {step1of(4)}
          <PanelText>Point your phone at a product and tap anywhere to scan. Your cards and settings are under the round button at the top right.</PanelText>
          <PanelActions>
          <BigButton label="Start shopping" icon="next" variant="primary" size="primary" onPress={finish} />
          </PanelActions>
        </InfoPanel>
      );
  }
}

function NameInput({ value, onChange, onSubmit }: { value: string; onChange: (s: string) => void; onSubmit: () => void }) {
  const { palette, settings } = useA11y();
  const size = Math.round(Type.body.fontSize * settings.textScale);
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      onSubmitEditing={onSubmit}
      autoFocus
      autoComplete="name"
      textContentType="name"
      returnKeyType="done"
      placeholder="First and last name"
      placeholderTextColor={palette.textMuted}
      accessibilityLabel="Your first and last name"
      style={[
        styles.input,
        { fontSize: size, color: palette.text, backgroundColor: palette.surface, borderColor: palette.primary },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  buttons: { gap: Spacing.md },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  grow: { flexGrow: 1, flexBasis: 110 },
  input: {
    minHeight: Target.min,
    borderWidth: 2,
    borderRadius: Radius.button,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
  },
});
