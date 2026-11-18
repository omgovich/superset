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
import { useEffect } from 'react';
import type { canvas as canvasApi } from '@apache-superset/core';
import { setActiveCanvas } from 'src/core';

export interface ActiveCanvasInput {
  id: number;
  title: string;
  /** Revision of the definition the page has loaded. */
  revision: number;
  /** The draft token in the page URL, if any. */
  draftToken?: string;
  /** Whether the definition on screen is that draft's own. */
  draftLoaded: boolean;
  /** The revision the draft's layout writes have reached. */
  draftRevision: number;
  /** Whether a change to the draft is in flight or not yet on screen. */
  draftChanging: boolean;
  /** Whether a saved version is shown in place of the canvas. */
  previewingVersion: boolean;
}

/**
 * What extensions are told about the open canvas. The draft is named only
 * once what is on screen is that draft at that revision, so an extension that
 * publishes it publishes what the user saw.
 */
export const activeCanvasOf = ({
  id,
  title,
  revision,
  draftToken,
  draftLoaded,
  draftRevision,
  draftChanging,
  previewingVersion,
}: ActiveCanvasInput): canvasApi.ActiveCanvas =>
  // Frozen: every listener gets the same object, and the host keeps it.
  Object.freeze({
    id,
    title,
    revision,
    ...(draftToken && draftLoaded && !draftChanging && !previewingVersion
      ? {
          draft: Object.freeze({ token: draftToken, revision: draftRevision }),
        }
      : {}),
    previewingVersion,
  });

/**
 * Tells extensions about the open canvas whenever any part of it changes.
 * Nothing is said for an undefined input. There is no cleanup: the page
 * clears the value when the canvas goes away, so remounting the body for a
 * version preview doesn't flash "no canvas" in between.
 */
export function usePublishActiveCanvas(input: ActiveCanvasInput | undefined) {
  const enabled = input !== undefined;
  const {
    id,
    title,
    revision,
    draftToken,
    draftLoaded,
    draftRevision,
    draftChanging,
    previewingVersion,
  } = input ?? {};
  useEffect(() => {
    if (
      !enabled ||
      id === undefined ||
      title === undefined ||
      revision === undefined
    ) {
      return;
    }
    setActiveCanvas(
      activeCanvasOf({
        id,
        title,
        revision,
        draftToken,
        draftLoaded: Boolean(draftLoaded),
        draftRevision: draftRevision ?? revision,
        draftChanging: Boolean(draftChanging),
        previewingVersion: Boolean(previewingVersion),
      }),
    );
  }, [
    enabled,
    id,
    title,
    revision,
    draftToken,
    draftLoaded,
    draftRevision,
    draftChanging,
    previewingVersion,
  ]);
}
