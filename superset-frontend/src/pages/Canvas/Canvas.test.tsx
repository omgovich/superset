/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import { act } from 'react';
import fetchMock from 'fetch-mock';
import { FeatureFlag } from '@superset-ui/core';
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from 'spec/helpers/testing-library';
import { canvas } from 'src/core';
import { subscribeRealtime } from 'src/middleware/realtime';
import CanvasPage from '.';

let mockIdOrSlug = '7';
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useParams: () => ({ idOrSlug: mockIdOrSlug }),
}));
jest.mock('src/middleware/realtime', () => ({
  connectRealtime: jest.fn(),
  subscribeRealtime: jest.fn(() => jest.fn()),
  subscribeRealtimeOpen: jest.fn(() => jest.fn()),
  subscribeRealtimeState: jest.fn(() => jest.fn()),
}));

const metadataEndpoint = 'glob:*/api/v1/canvas/7';
const definitionEndpoint = 'glob:*/api/v1/canvas/7/definition';

const definition = (children: string[], revision = 1, canEdit = false) => ({
  result: {
    version: 1,
    revision,
    canEdit,
    definition: {
      version: 1,
      root: { layout: { columns: 24, gap: 16, rowUnit: 40 }, children },
      nodes: Object.fromEntries(
        children.map(nodeId => [
          nodeId,
          { widgetId: `w-${nodeId}`, layout: {} },
        ]),
      ),
      interactions: { filters: {}, crossFilters: {}, customizations: {} },
      settings: {
        refresh: { interval: 0, stagger: 0, exempt: [] },
        colors: { labelColors: {} },
        display: { showTimestamps: false },
        crossFilters: { enabled: true },
      },
    },
    filterScopes: {},
    crossFilterScopes: {},
    customizationScopes: {},
    eventScopes: {},
    placements: {},
    layouts: {},
    childOrder: { root: children },
    widgetTypes: {},
    gridColumns: {},
    layoutConstraints: {},
  },
});

beforeEach(() => {
  fetchMock.removeRoutes();
  fetchMock.clearHistory();
  fetchMock.get(metadataEndpoint, {
    result: { id: 7, title: 'Exec overview', description: 'KPIs and trend' },
  });
});

test('shows the canvas title and an empty state', async () => {
  fetchMock.get(definitionEndpoint, definition([]));

  render(<CanvasPage />, { useRedux: true, useRouter: true });

  expect(await screen.findByText('Exec overview')).toBeInTheDocument();
  expect(screen.getByText('KPIs and trend')).toBeInTheDocument();
  expect(screen.getByText('This canvas is empty')).toBeInTheDocument();
  await waitFor(() =>
    expect(canvas.getActiveCanvas()).toStrictEqual({
      id: 7,
      title: 'Exec overview',
      revision: 1,
      previewingVersion: false,
    }),
  );
});

test('reloads the definition when this canvas changes', async () => {
  let notify: (payload: unknown) => void = () => {};
  jest.mocked(subscribeRealtime).mockImplementation((_topic, handler) => {
    notify = handler;
    return jest.fn();
  });
  // fetch-mock removes routes by name, not by matcher.
  fetchMock.get(definitionEndpoint, definition([]), {
    name: definitionEndpoint,
  });

  render(<CanvasPage />, { useRedux: true, useRouter: true });
  expect(await screen.findByText('This canvas is empty')).toBeInTheDocument();

  fetchMock.removeRoute(definitionEndpoint);
  fetchMock.get(definitionEndpoint, definition(['a'], 2), {
    name: definitionEndpoint,
  });
  // Another canvas changing is ignored; this one reloads.
  notify({ entity_type: 'canvas', id: 8 });
  notify({ entity_type: 'canvas', id: 7 });

  expect(
    await screen.findByText('This widget is unavailable'),
  ).toBeInTheDocument();
  expect(fetchMock.callHistory.calls(definitionEndpoint)).toHaveLength(2);
});

test('explains when the canvas cannot be opened', async () => {
  fetchMock.get(definitionEndpoint, 404);

  render(<CanvasPage />, { useRedux: true, useRouter: true });

  expect(
    await screen.findByText(
      'This canvas does not exist, or you do not have access to it',
    ),
  ).toBeInTheDocument();
});

test('the edit button opens the draft on this canvas', async () => {
  // The page is what connects the button to the draft: without
  // `onDraftOpened` wired to `draft.open`, it would create a draft the page
  // never shows, and nothing else here would notice.
  fetchMock.get(definitionEndpoint, definition([], 1, true));
  fetchMock.post('glob:*/api/v1/canvas/7/draft', {
    result: { token: 'tok-123', revision: 0 },
  });
  // Opening a draft refetches the definition from the draft's own route.
  fetchMock.get('glob:*/api/v1/canvas/draft', definition([], 0, true));

  render(<CanvasPage />, { useRedux: true, useRouter: true });

  const edit = await screen.findByRole('button', { name: 'Edit canvas' });
  // On the title row: the body owns the toolbar, but the page says where it
  // goes, and a toolbar on a row of its own was not the design.
  expect(screen.getByRole('banner')).toContainElement(edit);

  fireEvent.click(edit);

  // The draft banner only renders once the page is showing a draft.
  expect(
    await screen.findByText('Draft. Only you can see these changes.'),
  ).toBeInTheDocument();

  const [draftCall] = fetchMock.callHistory
    .calls()
    .filter(call => call.url.includes('/draft'));
  expect(draftCall.options.method?.toUpperCase()).toBe('POST');
  // And the draft the page opened is the one the request returned.
  await waitFor(() => expect(window.location.hash).toBe('#draft=tok-123'));
});

/**
 * What extensions are told about the draft and a version preview. The draft
 * named must be the one on screen: an extension uses it to publish what the
 * user reviewed, so a token or revision the screen hasn't caught up with is
 * worse than none.
 */

const draftEndpoint = 'glob:*/api/v1/canvas/draft';
const TITLE = 'Exec overview';

/** A draft of canvas 7, as the draft route returns it. */
const draftDefinition = (revision: number, canvasId = 7) => {
  const body = definition([], revision, true);
  return { result: { ...body.result, canvasId } };
};

const held = <T,>() => {
  let release: (value: T) => void = () => {};
  const promise = new Promise<T>(resolve => {
    release = resolve;
  });
  return { promise, release };
};

type Reply = unknown;

/**
 * Serves the draft route by token, a reply per request in turn; the last
 * reply keeps answering. A reply may be a promise, to hold the response.
 */
const serveDrafts = (replies: Record<string, Reply[]>) => {
  fetchMock.get(draftEndpoint, ({ options }) => {
    const token = (options.headers as Record<string, string> | undefined)?.[
      'x-canvas-draft'
    ];
    const queue = token ? replies[token] : undefined;
    if (!queue?.length) return 404;
    return queue.length > 1 ? queue.shift() : queue[0];
  });
};

const published = (revision: number) => ({
  id: 7,
  title: TITLE,
  revision,
  previewingVersion: false,
});

/**
 * A draft's definition on screen with no draft named: leaving it, another
 * one loading, or a failed refresh. The revision is the draft's own.
 */
const draftUnnamed = published;

const inDraft = (token: string, revision: number) => ({
  ...published(revision),
  draft: { token, revision },
});

const recordActiveCanvas = () => {
  const seen: unknown[] = [];
  const subscription = canvas.onDidChangeActiveCanvas((value: unknown) =>
    seen.push(value),
  );
  return { seen, stop: () => subscription.dispose() };
};

const renderPage = () =>
  render(<CanvasPage />, { useRedux: true, useRouter: true });

/** Lets responses already released land. */
const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });

const focusWindow = () => fireEvent.focus(window);

const originalFlags = window.featureFlags;

afterEach(() => {
  window.location.hash = '';
  window.featureFlags = originalFlags;
  mockIdOrSlug = '7';
});

test('nothing is said about a canvas still loading', async () => {
  const definitionReply = held<unknown>();
  fetchMock.get(definitionEndpoint, () => definitionReply.promise);

  renderPage();
  await waitFor(() =>
    expect(fetchMock.callHistory.calls(definitionEndpoint)).toHaveLength(1),
  );

  expect(canvas.getActiveCanvas()).toBeUndefined();

  definitionReply.release(definition([]));

  await waitFor(() =>
    expect(canvas.getActiveCanvas()).toStrictEqual(published(1)),
  );
});

test('a draft opened from the page is named once its definition has loaded', async () => {
  fetchMock.get(definitionEndpoint, definition([], 1, true));
  fetchMock.post('glob:*/api/v1/canvas/7/draft', {
    result: { token: 'tok-a', revision: 0 },
  });
  const draftReply = held<unknown>();
  serveDrafts({ 'tok-a': [draftReply.promise] });

  renderPage();
  const edit = await screen.findByRole('button', { name: 'Edit canvas' });
  await waitFor(() =>
    expect(canvas.getActiveCanvas()).toStrictEqual(published(1)),
  );
  const { seen, stop } = recordActiveCanvas();
  fireEvent.click(edit);
  await waitFor(() => expect(window.location.hash).toBe('#draft=tok-a'));
  await settle();

  // The published canvas is still what is on screen.
  expect(canvas.getActiveCanvas()).toStrictEqual(published(1));

  draftReply.release(draftDefinition(0));

  await waitFor(() =>
    expect(canvas.getActiveCanvas()).toStrictEqual(inDraft('tok-a', 0)),
  );
  expect(seen).toStrictEqual([inDraft('tok-a', 0)]);
  stop();
});

test('a refetch that moves the draft on names the new revision', async () => {
  window.location.hash = '#draft=tok-a';
  serveDrafts({ 'tok-a': [draftDefinition(3), draftDefinition(4)] });

  renderPage();
  await waitFor(() =>
    expect(canvas.getActiveCanvas()).toStrictEqual(inDraft('tok-a', 3)),
  );

  focusWindow();

  await waitFor(() =>
    expect(canvas.getActiveCanvas()).toStrictEqual(inDraft('tok-a', 4)),
  );
});

test('leaving a draft stops naming it straight away', async () => {
  window.location.hash = '#draft=tok-a';
  serveDrafts({ 'tok-a': [draftDefinition(2)] });
  const publishedReply = held<unknown>();
  fetchMock.get(definitionEndpoint, () => publishedReply.promise);

  renderPage();
  await waitFor(() =>
    expect(canvas.getActiveCanvas()).toStrictEqual(inDraft('tok-a', 2)),
  );
  const { seen, stop } = recordActiveCanvas();

  window.location.hash = '';
  await waitFor(() => expect(seen).toHaveLength(1));
  // The draft's definition is still on screen, but it is no longer open.
  expect(seen[0]).toStrictEqual(draftUnnamed(2));

  publishedReply.release(definition([]));

  await waitFor(() =>
    expect(canvas.getActiveCanvas()).toStrictEqual(published(1)),
  );
  expect(seen).toStrictEqual([draftUnnamed(2), published(1)]);
  stop();
});

test('switching drafts names neither until the new one has loaded', async () => {
  window.location.hash = '#draft=tok-a';
  const lateA = held<unknown>();
  const replyB = held<unknown>();
  serveDrafts({
    'tok-a': [draftDefinition(2), lateA.promise],
    'tok-b': [replyB.promise],
  });

  renderPage();
  await waitFor(() =>
    expect(canvas.getActiveCanvas()).toStrictEqual(inDraft('tok-a', 2)),
  );
  // A refetch of the first draft is still in flight when the user moves on.
  focusWindow();
  await waitFor(() =>
    expect(
      fetchMock.callHistory
        .calls(draftEndpoint)
        .filter(({ options }) => options.method?.toUpperCase() === 'GET'),
    ).toHaveLength(2),
  );
  const { seen, stop } = recordActiveCanvas();

  window.location.hash = '#draft=tok-b';
  await waitFor(() =>
    expect(canvas.getActiveCanvas()).toStrictEqual(draftUnnamed(2)),
  );

  lateA.release(draftDefinition(3));
  await settle();

  expect(canvas.getActiveCanvas()).toStrictEqual(draftUnnamed(2));

  replyB.release(draftDefinition(0));

  await waitFor(() =>
    expect(canvas.getActiveCanvas()).toStrictEqual(inDraft('tok-b', 0)),
  );
  expect(seen).toStrictEqual([draftUnnamed(2), inDraft('tok-b', 0)]);
  stop();
});

test('a draft that fails to open is never named', async () => {
  window.location.hash = '#draft=tok-a';
  serveDrafts({});

  renderPage();

  expect(
    await screen.findByText('This draft is no longer available'),
  ).toBeInTheDocument();
  expect(canvas.getActiveCanvas()).toBeUndefined();
});

test('a draft whose refresh fails is not named until one succeeds', async () => {
  // The last good definition stays on screen, but the draft may have been
  // published or discarded meanwhile.
  window.location.hash = '#draft=tok-a';
  serveDrafts({ 'tok-a': [draftDefinition(2), 500, draftDefinition(2)] });

  renderPage();
  await waitFor(() =>
    expect(canvas.getActiveCanvas()).toStrictEqual(inDraft('tok-a', 2)),
  );

  focusWindow();

  await waitFor(() =>
    expect(canvas.getActiveCanvas()).toStrictEqual(draftUnnamed(2)),
  );
  expect(
    screen.getByText('Draft. Only you can see these changes.'),
  ).toBeInTheDocument();

  focusWindow();

  await waitFor(() =>
    expect(canvas.getActiveCanvas()).toStrictEqual(inDraft('tok-a', 2)),
  );
});

test('an older response that lands last does not take the draft back', async () => {
  window.location.hash = '#draft=tok-a';
  const slow = held<unknown>();
  serveDrafts({
    'tok-a': [draftDefinition(4), slow.promise, draftDefinition(6)],
  });

  renderPage();
  await waitFor(() =>
    expect(canvas.getActiveCanvas()).toStrictEqual(inDraft('tok-a', 4)),
  );

  focusWindow();
  focusWindow();
  await waitFor(() =>
    expect(canvas.getActiveCanvas()).toStrictEqual(inDraft('tok-a', 6)),
  );

  slow.release(draftDefinition(5));
  await settle();

  expect(canvas.getActiveCanvas()).toStrictEqual(inDraft('tok-a', 6));
});

test('a draft of another canvas says nothing', async () => {
  // Its revision is not this canvas's, so naming even that would mislead.
  window.location.hash = '#draft=tok-a';
  serveDrafts({ 'tok-a': [draftDefinition(0, 8)] });

  renderPage();

  expect(
    await screen.findByText('Draft. Only you can see these changes.'),
  ).toBeInTheDocument();
  await settle();
  expect(canvas.getActiveCanvas()).toBeUndefined();
});

const versionsEndpoint = 'glob:*/api/v1/canvas/c-uuid/versions/';
const olderVersionEndpoint = 'glob:*/api/v1/canvas/c-uuid/versions/v-1/';

const versionMeta = (uuid: string, number: number) => ({
  version_uuid: uuid,
  version_number: number,
  transaction_id: number,
  operation_type: number === 0 ? 'baseline' : 'update',
  issued_at: '2026-01-01T00:00:00Z',
  changed_by: null,
  changes: [],
});

const withVersionHistory = () => {
  window.featureFlags = {
    ...originalFlags,
    [FeatureFlag.VersionHistory]: true,
  };
  fetchMock.removeRoutes();
  fetchMock.get(metadataEndpoint, {
    result: { id: 7, uuid: 'c-uuid', title: TITLE },
  });
  fetchMock.get(versionsEndpoint, {
    result: [
      versionMeta('v-0', 0),
      versionMeta('v-1', 1),
      versionMeta('v-2', 2),
    ],
  });
};

const snapshotOf = (uuid: string, number: number, children: string[]) => ({
  result: {
    title: TITLE,
    rendered: definition(children, 1).result,
    _version: versionMeta(uuid, number),
  },
});

const snapshot = snapshotOf('v-1', 1, ['a']);

/** Newest first: the current version, then `v-1`, then `v-0`. */
const versionEntries = async () => {
  fireEvent.click(await screen.findByTestId('canvas-version-history-button'));
  return screen.findAllByTestId('canvas-version');
};

const openOlderVersion = async () => {
  fireEvent.click((await versionEntries())[1]);
};

test('a version preview is said while it is on screen', async () => {
  withVersionHistory();
  fetchMock.get(definitionEndpoint, definition([], 3));
  fetchMock.get(olderVersionEndpoint, snapshot);

  renderPage();
  await waitFor(() =>
    expect(canvas.getActiveCanvas()).toStrictEqual(published(3)),
  );

  await openOlderVersion();

  // The live canvas' revision, not the snapshot's: a preview is not a change.
  await waitFor(() =>
    expect(canvas.getActiveCanvas()).toStrictEqual({
      ...published(3),
      previewingVersion: true,
    }),
  );

  fireEvent.click(screen.getByRole('button', { name: 'Back to current' }));

  await waitFor(() =>
    expect(canvas.getActiveCanvas()).toStrictEqual(published(3)),
  );
});

test('a preview that loads after a draft opened is not shown', async () => {
  withVersionHistory();
  fetchMock.get(definitionEndpoint, definition([], 3, true));
  const lateSnapshot = held<unknown>();
  fetchMock.get(olderVersionEndpoint, () => lateSnapshot.promise);
  fetchMock.post('glob:*/api/v1/canvas/7/draft', {
    result: { token: 'tok-a', revision: 0 },
  });
  serveDrafts({ 'tok-a': [draftDefinition(0)] });

  renderPage();
  await openOlderVersion();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit canvas' }));
  await waitFor(() =>
    expect(canvas.getActiveCanvas()).toStrictEqual(inDraft('tok-a', 0)),
  );

  lateSnapshot.release(snapshot);
  await settle();

  expect(
    document.querySelector('[data-test="canvas-version-preview"]'),
  ).not.toBeInTheDocument();
  expect(canvas.getActiveCanvas()).toStrictEqual(inDraft('tok-a', 0));
});

test('leaving the page says no canvas is open', async () => {
  fetchMock.get(definitionEndpoint, definition([]));

  const { unmount } = renderPage();
  await waitFor(() =>
    expect(canvas.getActiveCanvas()).toStrictEqual(published(1)),
  );

  unmount();

  expect(canvas.getActiveCanvas()).toBeUndefined();
});

test('of two versions clicked in turn, the second is the one previewed', async () => {
  withVersionHistory();
  fetchMock.get(definitionEndpoint, definition([], 3));
  const first = held<unknown>();
  fetchMock.get(olderVersionEndpoint, () => first.promise);
  fetchMock.get(
    'glob:*/api/v1/canvas/c-uuid/versions/v-0/',
    snapshotOf('v-0', 0, ['a', 'b']),
  );

  renderPage();
  const entries = await versionEntries();
  fireEvent.click(entries[1]);
  fireEvent.click(entries[2]);

  await waitFor(() =>
    expect(screen.getAllByText('This widget is unavailable')).toHaveLength(2),
  );

  first.release(snapshot);
  await settle();

  // Still the second: the first answered last, but was asked first.
  expect(screen.getAllByText('This widget is unavailable')).toHaveLength(2);
  expect(canvas.getActiveCanvas()).toStrictEqual({
    ...published(3),
    previewingVersion: true,
  });
});

test('restoring a version ends the preview', async () => {
  withVersionHistory();
  fetchMock.get(definitionEndpoint, definition([], 3), {
    name: definitionEndpoint,
  });
  fetchMock.get(olderVersionEndpoint, snapshot);
  fetchMock.post('glob:*/api/v1/canvas/c-uuid/versions/v-1/restore', {
    result: { revision: 4, skippedPlacements: [] },
  });

  renderPage();
  await openOlderVersion();
  await waitFor(() =>
    expect(canvas.getActiveCanvas()).toStrictEqual({
      ...published(3),
      previewingVersion: true,
    }),
  );
  const { seen, stop } = recordActiveCanvas();
  fetchMock.removeRoute(definitionEndpoint);
  fetchMock.get(definitionEndpoint, definition([], 4));

  const restoreButtons = () =>
    screen.getAllByRole('button', { name: 'Restore this version' });
  fireEvent.click(restoreButtons()[0]);
  // The banner's button, then the confirmation's.
  await waitFor(() => expect(restoreButtons()).toHaveLength(2));
  fireEvent.click(restoreButtons()[1]);

  await waitFor(() =>
    expect(canvas.getActiveCanvas()).toStrictEqual(published(4)),
  );
  // Whether the restored revision lands with the preview's end or after it
  // is down to timing; the preview is over either way.
  expect(seen.length).toBeGreaterThan(0);
  seen.forEach(value =>
    expect(value).toMatchObject({ previewingVersion: false }),
  );
  stop();
});

test('a version still loading when another is restored is not shown after it', async () => {
  withVersionHistory();
  fetchMock.get(definitionEndpoint, definition([], 3), {
    name: definitionEndpoint,
  });
  fetchMock.get(olderVersionEndpoint, snapshot);
  const oldest = held<unknown>();
  fetchMock.get(
    'glob:*/api/v1/canvas/c-uuid/versions/v-0/',
    () => oldest.promise,
  );
  fetchMock.post('glob:*/api/v1/canvas/c-uuid/versions/v-1/restore', {
    result: { revision: 4, skippedPlacements: [] },
  });

  renderPage();
  fireEvent.click((await versionEntries())[1]);
  await waitFor(() =>
    expect(canvas.getActiveCanvas()).toStrictEqual({
      ...published(3),
      previewingVersion: true,
    }),
  );
  // Another version is asked for, then the one on screen is restored.
  fireEvent.click(screen.getAllByTestId('canvas-version')[2]);
  fetchMock.removeRoute(definitionEndpoint);
  fetchMock.get(definitionEndpoint, definition([], 4));
  const restoreButtons = () =>
    screen.getAllByRole('button', { name: 'Restore this version' });
  fireEvent.click(restoreButtons()[0]);
  await waitFor(() => expect(restoreButtons()).toHaveLength(2));
  fireEvent.click(restoreButtons()[1]);
  await waitFor(() =>
    expect(canvas.getActiveCanvas()).toStrictEqual(published(4)),
  );

  oldest.release(snapshotOf('v-0', 0, ['a', 'b']));
  await settle();

  expect(
    document.querySelector('[data-test="canvas-version-preview"]'),
  ).not.toBeInTheDocument();
  expect(canvas.getActiveCanvas()).toStrictEqual(published(4));
});

test('moving to another canvas says nothing of it until it has loaded', async () => {
  // The page stays mounted when only the id changes, and for a render still
  // holds the previous canvas's title and definition.
  fetchMock.get(definitionEndpoint, definition([], 3));
  const otherMetadata = held<unknown>();
  const otherDefinition = held<unknown>();
  fetchMock.get('glob:*/api/v1/canvas/8', () => otherMetadata.promise);
  fetchMock.get(
    'glob:*/api/v1/canvas/8/definition',
    () => otherDefinition.promise,
  );

  const { rerender } = renderPage();
  await waitFor(() =>
    expect(canvas.getActiveCanvas()).toStrictEqual(published(3)),
  );
  const { seen, stop } = recordActiveCanvas();

  mockIdOrSlug = '8';
  rerender(<CanvasPage />);
  await settle();

  expect(canvas.getActiveCanvas()).toBeUndefined();

  otherMetadata.release({ result: { id: 8, title: 'Sales' } });
  otherDefinition.release(definition([], 1));

  await waitFor(() =>
    expect(canvas.getActiveCanvas()).toStrictEqual({
      id: 8,
      title: 'Sales',
      revision: 1,
      previewingVersion: false,
    }),
  );
  expect(seen).toStrictEqual([
    undefined,
    { id: 8, title: 'Sales', revision: 1, previewingVersion: false },
  ]);
  stop();
});

test('a canvas that fails after a draft was named says nothing', async () => {
  // Leaving the draft for a published canvas that cannot be read.
  window.location.hash = '#draft=tok-a';
  serveDrafts({ 'tok-a': [draftDefinition(2)] });
  fetchMock.get(definitionEndpoint, 404);

  renderPage();
  await waitFor(() =>
    expect(canvas.getActiveCanvas()).toStrictEqual(inDraft('tok-a', 2)),
  );

  window.location.hash = '';

  expect(
    await screen.findByText(
      'This canvas does not exist, or you do not have access to it',
    ),
  ).toBeInTheDocument();
  expect(canvas.getActiveCanvas()).toBeUndefined();
});

test('an older refresh failing after a newer one succeeded does not hide the draft', async () => {
  window.location.hash = '#draft=tok-a';
  const slowFailure = held<unknown>();
  serveDrafts({
    'tok-a': [draftDefinition(2), slowFailure.promise, draftDefinition(3)],
  });

  renderPage();
  await waitFor(() =>
    expect(canvas.getActiveCanvas()).toStrictEqual(inDraft('tok-a', 2)),
  );

  focusWindow();
  focusWindow();
  await waitFor(() =>
    expect(canvas.getActiveCanvas()).toStrictEqual(inDraft('tok-a', 3)),
  );

  slowFailure.release(500);
  await settle();

  expect(canvas.getActiveCanvas()).toStrictEqual(inDraft('tok-a', 3));
});

test('going back to the current canvas drops a preview still loading', async () => {
  withVersionHistory();
  fetchMock.get(definitionEndpoint, definition([], 3));
  fetchMock.get(olderVersionEndpoint, snapshot);
  const second = held<unknown>();
  fetchMock.get(
    'glob:*/api/v1/canvas/c-uuid/versions/v-0/',
    () => second.promise,
  );

  renderPage();
  const entries = await versionEntries();
  fireEvent.click(entries[1]);
  await waitFor(() =>
    expect(canvas.getActiveCanvas()).toStrictEqual({
      ...published(3),
      previewingVersion: true,
    }),
  );
  fireEvent.click(entries[2]);
  fireEvent.click(screen.getByRole('button', { name: 'Back to current' }));
  await waitFor(() =>
    expect(canvas.getActiveCanvas()).toStrictEqual(published(3)),
  );

  second.release(snapshotOf('v-0', 0, ['a', 'b']));
  await settle();

  expect(
    document.querySelector('[data-test="canvas-version-preview"]'),
  ).not.toBeInTheDocument();
  expect(canvas.getActiveCanvas()).toStrictEqual(published(3));
});
