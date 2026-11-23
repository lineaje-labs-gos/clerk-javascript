import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { AuthActionBlockedDetails } from '../../blocks/auth';
import { usePendingAction } from '../../hooks/use-pending-action';
import type { ErrorDescription } from '../../localization';
import { useErrorText } from '../../localization';
import { setup } from '../../machine/setup';
import type { ErrorInvokeEvent } from '../../machine/types';
import { useMachine } from '../../machine/use-machine';
import type { MosaicLocationOptions } from '../../routing/use-mosaic-location';
import { useRouteGuard } from '../../routing/use-route-guard';
import { useRouterScope } from '../../routing/use-router';
import { toLocalizableError } from '../../utils/errors';
import type { SignUpCreateResult, SignUpFlowModel, SignUpReadyModel } from './sign-up.model';
import type { SignUpRoute } from './sign-up.routes';
import { detailsRouteFor, routeFor, shownRoute, signUpRoutes } from './sign-up.routes';
import type { SignUpProtectScreen, SignUpScreen, SignUpVerifyScreen, SignUpViewProps } from './sign-up.types';
import { useSignUpDetailsController } from './sign-up-details/sign-up-details.controller';

interface FinishContext {
  frozenModel: SignUpReadyModel | null;
  frozenScreen: 'loading' | undefined;
  isNextScreenLoading: boolean;
  error: ErrorDescription | undefined;
}

type FinishEvent = { type: 'FINISH'; frozenModel: SignUpReadyModel; frozenScreen?: 'loading' };

const finish = setup<FinishContext, FinishEvent>();

const startFinishing = {
  FINISH: {
    target: 'finishing' as const,
    actions: finish.assign<FinishEvent>((_, event) => ({
      frozenModel: event.frozenModel,
      frozenScreen: event.frozenScreen,
      error: undefined,
    })),
  },
};

const finishMachine = finish.createMachine({
  id: 'signUpFinish',
  initial: 'idle',
  context: {
    frozenModel: null,
    frozenScreen: undefined,
    isNextScreenLoading: false,
    error: undefined,
  },
  states: {
    idle: {
      on: startFinishing,
    },
    finishing: {
      invoke: finish.fromPromise(context => context.frozenModel?.flow.finalize() ?? Promise.resolve(), {
        onDone: { target: 'handingOff' },
        onError: {
          target: 'idle',
          actions: finish.assign<ErrorInvokeEvent>((_, event) => ({
            frozenModel: null,
            frozenScreen: undefined,
            error: toLocalizableError(event.error),
          })),
        },
      }),
    },
    handingOff: {
      always: {
        guard: context => !context.isNextScreenLoading,
        target: 'finished',
        actions: finish.assign(() => ({ frozenModel: null, frozenScreen: undefined })),
      },
    },
    finished: {
      on: startFinishing,
    },
  },
});

function screenFor(route: SignUpRoute | undefined, flow: SignUpFlowModel, isBlocked: boolean): SignUpScreen {
  if (route === undefined || route === 'enterpriseConnections') {
    return 'startOver';
  }
  if (isBlocked && (route === 'start' || route === 'protectCheck' || route === 'continueProtectCheck')) {
    return 'actionBlocked';
  }
  if (route !== 'start') {
    return route;
  }
  return flow.mode === 'public' || flow.ticket ? 'start' : flow.mode;
}

type SignUpControllerResult =
  | { status: 'hidden' }
  | (Omit<
      SignUpViewProps,
      'applicationName' | 'logo' | 'taskChooseOrganization' | 'verifyEmail' | 'verifyPhone' | 'protectCheck'
    > & {
      status: 'ready';
      attempt?: string;
      verifyEmail: SignUpVerifyScreen;
      verifyPhone: SignUpVerifyScreen;
      protectCheck: SignUpProtectScreen;
    });

export function useSignUpController(
  liveModel: SignUpReadyModel,
  { isTaskReady, ...options }: MosaicLocationOptions & { isTaskReady: boolean },
): SignUpControllerResult {
  const { route, go } = useRouterScope(signUpRoutes, { ...options, root: 'start' });
  const actions = usePendingAction<'startOver' | 'ticket' | 'return'>();
  const redeemedTicket = useRef<string | undefined>(undefined);
  const errorText = useErrorText();
  const liveStep = liveModel.flow.step;
  const isNextScreenLoading = liveStep.type === 'leaving' || (liveStep.type === 'task' && !isTaskReady);
  const [finishSnapshot, sendFinish, finishActor] = useMachine(finishMachine, { context: { isNextScreenLoading } });
  const [signedInVisit] = useState(() => (liveStep.type === 'signed_in' ? { leave: liveModel.flow.leave } : undefined));
  const [blocked, setBlocked] = useState<AuthActionBlockedDetails>();
  const expiredProtectReloads = useRef(0);
  const arrivedSignedIn = signedInVisit !== undefined;
  const leavesOnArrival = signedInVisit?.leave !== undefined;

  useEffect(() => signedInVisit?.leave?.(), [signedInVisit]);

  useLayoutEffect(() => {
    finishActor.recheck();
  }, [isNextScreenLoading, finishActor]);

  const model = finishSnapshot.context.frozenModel ?? liveModel;
  const { flow, navigation, verification } = model;
  // The marker is in the URL from the first paint, before the effect starts the return. `lastKey` is set once it ran.
  const isReturning = actions.pendingKey === 'return' || (flow.isReturning && actions.lastKey === undefined);
  const isFinishing = finishSnapshot.value === 'finishing' || finishSnapshot.value === 'handingOff';
  const shown = shownRoute(route, flow.step.type === 'signed_in' && !arrivedSignedIn ? { type: 'leaving' } : flow.step);
  const isFlowOver = finishSnapshot.value === 'finished' || shown === 'taskChooseOrganization';
  const isHidden = liveStep.type === 'signed_in' && (leavesOnArrival || isFlowOver);
  const screen =
    isReturning || actions.pendingKey === 'ticket'
      ? 'loading'
      : (finishSnapshot.context.frozenScreen ?? screenFor(shown, flow, blocked !== undefined));

  useRouteGuard({ route, go }, shown);

  const next = (result: SignUpCreateResult, frozenScreen?: 'loading') => {
    if (result.type === 'blocked') {
      setBlocked(result.details);
      return;
    }
    if (result.type === 'complete') {
      sendFinish({ type: 'FINISH', frozenModel: model, frozenScreen });
      return;
    }
    if (result.type === 'transfer') {
      completeReturn();
      return;
    }
    const nextRoute = routeFor(result, route);
    if (nextRoute) {
      go(nextRoute);
    }
  };

  const completeReturn = () =>
    void actions.run('return', async () => {
      const step = await flow.completeReturn();
      if (step) {
        next(step);
      }
    });

  const finishError = finishSnapshot.context.error ? errorText(finishSnapshot.context.error) : undefined;
  const flowError = finishError ?? actions.error;
  const details = useSignUpDetailsController(model.details, {
    purpose: screen === 'continue' ? 'continue' : 'start',
    isBusy: actions.isPending || isFinishing,
    globalErrorMessage: flowError,
    onSubmit: actions.reset,
    onNext: next,
    onSignIn: navigation.goToSignIn,
  });
  /* eslint-disable react-you-might-not-need-an-effect/no-event-handler -- Completes an OAuth return once when sign-up opens with its marker in the URL, on any route, or redeems an invitation once when it opens on start with its ticket; arriving from a redirect or a link is not an event a handler could run from. */
  useEffect(() => {
    if (flow.isReturning && actions.lastKey === undefined) {
      completeReturn();
      return;
    }
    if (
      isReturning ||
      actions.isPending ||
      !flow.ticket ||
      model.details.inTicketSignUp ||
      route !== 'start' ||
      redeemedTicket.current === flow.ticket
    ) {
      return;
    }
    redeemedTicket.current = flow.ticket;
    void actions.run('ticket', async () => {
      const { result, emailAddress } = await flow.redeemTicket();
      details.adoptInvitation(emailAddress);
      next(result, 'loading');
    });
  });
  /* eslint-enable react-you-might-not-need-an-effect/no-event-handler */

  const verify = {
    onNext: next,
    isPending: isFinishing,
    globalErrorMessage: finishError,
    onEditIdentifier: () => {
      details.leaveChannel();
      go(detailsRouteFor(route));
    },
  };

  if (isHidden) {
    return { status: 'hidden' };
  }

  return {
    status: 'ready',
    screen: screen === 'start' && details.alternativePhone ? 'alternativePhone' : screen,
    attempt: flow.signUpId,
    alternativePhone: details.alternativePhone,
    start: details.start,
    continue: details.continue,
    verifyEmail: { ...verify, verification: verification.email },
    verifyPhone: { ...verify, verification: verification.phone },
    protectCheck: {
      protect: model.protect,
      expiredReloads: expiredProtectReloads,
      onNext: next,
      isPending: isFinishing,
      globalErrorMessage: finishError,
    },
    restricted: {
      globalErrorMessage: details.error ?? flowError,
      onEmailSupport: navigation.emailSupport,
      onJoinWaitlist: navigation.joinWaitlist,
      onSignIn: navigation.goToSignIn,
    },
    actionBlocked: blocked,
    startOver: {
      isPending: actions.isPending,
      globalErrorMessage: actions.error,
      onStartOver: () =>
        void actions.run('startOver', async () => {
          await flow.reset();
          details.reset();
          go('start');
        }),
    },
  };
}
