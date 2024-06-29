import { Bridge, Channel, ChannelDtmfReceived, LiveRecording, Playback, StasisEnd } from 'ari-client';
import { config } from '../config/config';
import { InboundNumber } from '../entities/InboundNumber';
import { logger } from '../misc/Logger';
import { AriData } from '../types/AriData';
import { CallRecordingService } from './CallRecordingService';
import { InboundNumberService } from './InboundNumberService';
import { PromptCitationData } from '../types/PromptCitationData';
import { CitationApiService } from './CitationApiService';
import { CallbackQueue } from '../queues/CallbackQueue';

export class InboundQueueService {
  static getListOfQueuePhoneNumbers(inboundNumber: InboundNumber): string[] {
    return inboundNumber.queue_numbers.split(',').map(phone => phone.trim());
  }

  static async callQueueMember(
    phoneNumber: string,
    ariData: AriData,
    isPromptCitationQueue: boolean = false,
    promptCitationData?: PromptCitationData
  ): Promise<boolean> {
    const { client, channel: inboundChannel } = ariData;

    let success = false;

    logger.debug(`Calling queue member ${phoneNumber}`);

    const outboundChannel = client.Channel();
    try {
      await outboundChannel.originate({
        endpoint: phoneNumber.length > 4 ? `PJSIP/${phoneNumber}@${config.trunkName}` : `PJSIP/${phoneNumber}`,
        app: config.ari.app,
        appArgs: 'dialed',
        timeout: isPromptCitationQueue ? 3600 : config.inboundQueue.ringTime,
        callerId: inboundChannel.caller.number
      });
    } catch (err) {
      logger.error(`Error while calling queue member ${phoneNumber}`, err);
      return false;
    }

    const callbackChannel = client.Channel();
    const callbackBridge = client.Bridge();
    const bridge = client.Bridge();

    outboundChannel.once('StasisStart', async () => {
      logger.debug(`External queue channel ${outboundChannel.id} answered`);
      await InboundNumberService.stopPlayback(ariData.playback as Playback);

      try {
        await client.channels.get({ channelId: inboundChannel.id });
      } catch (err) {
        await this.promptCitationCallback(callbackChannel, outboundChannel, bridge, callbackBridge);
      }

      success = true;
      await inboundChannel.stopMoh();

      try {
        outboundChannel.once('StasisEnd', () => {
          logger.debug(`External queue channel ${outboundChannel.id} got StasisEnd`);

          logger.debug(`Destroying bridge ${bridge.id}`);
          InboundNumberService.destroyBridge(bridge);
          InboundNumberService.hangupChannel(inboundChannel);
          InboundNumberService.destroyBridge(callbackBridge);
          InboundNumberService.hangupChannel(callbackChannel);
        });

        if (isPromptCitationQueue && promptCitationData) {
          promptCitationData.extension = phoneNumber;
          void CitationApiService.sendNotificationRequest(promptCitationData);
        }

        bridge.create({ type: 'mixing' }, () => {
          logger.debug(`Bridge ${bridge.id} created`);
          // await inboundChannel.answer();
          bridge.addChannel({ channel: [inboundChannel.id, outboundChannel.id] });
          logger.debug(`Channels ${inboundChannel.id} and ${outboundChannel.id} were added to bridge ${bridge.id}`);
        });
      } catch (err) {
        logger.debug('No outbound channel');
      }
    });

    try {
      return await new Promise(resolve => {
        outboundChannel.once('ChannelDestroyed', () => {
          logger.debug(`External channel ${outboundChannel.id} got ChannelDestroyed`);
          resolve(success);
        });
      });
    } catch (err) {
      return false;
    }
  }

  static async promptCitationCallback(
    callbackChannel: Channel,
    outboundChannel: Channel,
    bridge: Bridge,
    callbackBridge: Bridge
  ): Promise<void> {
    // TODO: Proceed with callback from the callback queue
    const callbackQueue = CallbackQueue.getInstance<PromptCitationData>();
    const callbackData = callbackQueue.dequeue();

    if (callbackData) {
      logger.debug(`Proceeding with callback to ${callbackData.dialedPhoneNumber}`);

      callbackChannel.once('StasisStart', () => {
        logger.debug(`Callback channel ${callbackChannel.id} answered`);

        callbackChannel.once('StasisEnd', () => {
          logger.debug(`Callback channel ${callbackChannel.id} got StasisEnd`);
          logger.debug(`Destroying bridge ${callbackBridge.id}`);
          InboundNumberService.destroyBridge(bridge);
          InboundNumberService.destroyBridge(callbackBridge);
          InboundNumberService.hangupChannel(outboundChannel);
        });

        callbackBridge.create({ type: 'mixing' }, async () => {
          logger.debug(`Bridge ${callbackBridge.id} created`);
          await callbackBridge.addChannel({ channel: [outboundChannel.id, callbackChannel.id] });
          logger.debug(
            `Channels ${outboundChannel.id} and ${callbackChannel.id} were added to bridge ${callbackBridge.id}`
          );
        });
      });

      try {
        const { callerIdNumber: phoneNumber, dialedPhoneNumber } = callbackData;

        await callbackChannel.originate({
          endpoint: phoneNumber.length > 4 ? `PJSIP/${phoneNumber}@${config.trunkName}` : `PJSIP/${phoneNumber}`,
          app: config.ari.app,
          appArgs: 'dialed',
          callerId: dialedPhoneNumber
        });

        logger.debug(`Callback channel ${callbackChannel.id} originated to ${phoneNumber}`);
      } catch (err) {
        logger.error(`Error while calling back to ${callbackData.dialedPhoneNumber}: ${err}`);
      }
    }
  }

  static async callQueueMembersRingall(
    queueNumbers: string[],
    ariData: AriData,
    isPromptCitationQueue: boolean = false,
    promptCitationData?: PromptCitationData
  ): Promise<boolean> {
    if (queueNumbers.length === 0) {
      logger.error(`No queue numbers found`);
      return false;
    }

    logger.debug(`Calling queue members ${queueNumbers.join(', ')}`);

    let success = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ongoingCalls: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let answeredChannel: any = null;

    for (const number of queueNumbers) {
      ongoingCalls.push(
        this.callQueueMember(number, ariData, isPromptCitationQueue, promptCitationData).then(answered => {
          if (answered && answeredChannel === null) {
            answeredChannel = number;
            success = true;
            // Drop other calls
            ongoingCalls.forEach(call => {
              if (call.phoneNumber !== number) {
                InboundNumberService.hangupChannel(call.outboundChannel);
              }
            });
          }
        })
      );
    }

    // Wait for all calls to finish
    await Promise.all(ongoingCalls);

    return success;
  }

  static async callQueueMembers(
    queueNumbers: string[],
    ariData: AriData,
    isPromptCitationQueue: boolean = false,
    promptCitationData?: PromptCitationData
  ): Promise<boolean> {
    if (queueNumbers.length === 0) {
      logger.error(`No queue numbers found`);
      return false;
    }

    logger.debug(`Calling queue members ${queueNumbers.join(', ')}`);

    let success = false;
    const agentChannels: Channel[] = [];
    for (const number of queueNumbers) {
      const channel = ariData.client.Channel();
      agentChannels.push(channel);

      try {
        await ariData.client.channels.get({ channelId: ariData.channel.id });
        success = await this.callQueueMember(number, ariData, isPromptCitationQueue, promptCitationData);

        if (success) {
          for (const ch of agentChannels) {
            void InboundNumberService.hangupChannel(ch);
          }
          break;
        }
      } catch (err) {
        logger.debug('Inbound channel is not alive anymore');
      }
    }

    return success;
  }

  static async inboundQueueHandler(
    inboundNumber: InboundNumber,
    inboundDID: string,
    ariData: AriData
  ): Promise<string | void> {
    const { channel: inboundChannel } = ariData;
    const liveRecording = await CallRecordingService.createRecordingChannel(ariData);

    inboundChannel.on('StasisEnd', async (event: StasisEnd, channel: Channel): Promise<void> => {
      await InboundNumberService.stopRecording(channel, liveRecording);
      logger.debug(`${event.type} on ${channel.name}`);
    });

    logger.debug(`Starting inbound queue for ${inboundDID} and channel ${inboundChannel.name}`);
    const queueNumbers = InboundQueueService.getListOfQueuePhoneNumbers(inboundNumber);
    const success = await InboundQueueService.callQueueMembers(queueNumbers, ariData);

    if (!success) {
      try {
        logger.debug(`Redirecting channel ${inboundChannel.name} to voicemail ${inboundNumber.voicemail}`);
        await inboundChannel.answer();
        await inboundChannel.setChannelVar({ variable: 'MESSAGE', value: inboundNumber.message });
        await inboundChannel.continueInDialplan({
          context: config.voicemail.context,
          extension: inboundNumber.voicemail,
          priority: 1
        });
      } catch (err) {
        logger.error(
          `Error while redirecting channel ${inboundChannel.name} to voicemail ${inboundNumber.voicemail}`,
          err
        );
      }
    }
  }

  static async callbackRequestHandler(
    inboundChannel: Channel,
    event: ChannelDtmfReceived,
    playback: Playback,
    liveRecording: LiveRecording,
    promptCitationData: PromptCitationData
  ): Promise<void> {
    if (event.digit !== '1') {
      return;
    }

    logger.info(`Channel ${inboundChannel.id} pressed 1 to request a callback, processing`);
    inboundChannel.removeAllListeners('ChannelDtmfReceived');
    await InboundNumberService.stopPlayback(playback);
    await InboundNumberService.stopRecording(inboundChannel, liveRecording);

    const callbackQueue = CallbackQueue.getInstance<PromptCitationData>();
    callbackQueue.enqueue(promptCitationData);

    // TODO: we need to say phone number here
    await inboundChannel.play(
      {
        media: [
          `sound:${config.promptCitation.queueCallbackConfirmationSoundOne}`,
          `sound:${config.promptCitation.queueCallbackConfirmationSoundTwo}`
        ]
      },
      playback
    );

    playback.once('PlaybackFinished', async () => {
      await InboundNumberService.hangupChannel(inboundChannel);
    });
  }

  static async promptCitationQueueHandler(
    inboundNumber: InboundNumber,
    promptCitationData: PromptCitationData,
    ariData: AriData
  ): Promise<void> {
    const { channel: inboundChannel, client } = ariData;
    const liveRecording = await CallRecordingService.createRecordingChannel(ariData);

    const playback = client.Playback();

    inboundChannel.on('StasisEnd', async (event: StasisEnd, channel: Channel): Promise<void> => {
      await InboundNumberService.stopRecording(channel, liveRecording);
      logger.debug(`${event.type} on ${channel.name}`);
    });

    inboundChannel.on('ChannelDtmfReceived', async (event: ChannelDtmfReceived): Promise<void> => {
      await this.callbackRequestHandler(inboundChannel, event, playback, liveRecording, promptCitationData);
    });

    try {
      await inboundChannel.play({ media: `sound:${config.promptCitation.queueCallbackInfoSound}` }, playback);
      await inboundChannel.startMoh();
    } catch (err) {
      logger.error('Cannot play callback info sound on an inbound channel — there is no channel anymore');
      return;
    }

    const playCallbackInfoSoundInterval = setInterval(async () => {
      try {
        await inboundChannel.stopMoh();
        await inboundChannel.play({ media: `sound:${config.promptCitation.queueCallbackInfoSound}` }, playback);
        await inboundChannel.startMoh();
      } catch (err) {
        logger.debug(`Failed to process callback info audio interval on channel ${inboundChannel.id}`);
      }
    }, config.promptCitation.queueCallbackInfoSoundInterval);

    logger.debug(
      `Starting inbound queue for ${promptCitationData.dialedPhoneNumber} and channel ${inboundChannel.name}`
    );
    const queueNumbers = InboundQueueService.getListOfQueuePhoneNumbers(inboundNumber);
    const success = await InboundQueueService.callQueueMembers(
      queueNumbers,
      { ...ariData, playback },
      true,
      promptCitationData
    );

    clearInterval(playCallbackInfoSoundInterval);
    try {
      void inboundChannel.stopMoh();
    } catch (err) {
      logger.debug(`Stopping MOH failed on ${inboundChannel.id}: there is no channel`);
    }

    if (!success) {
      try {
        logger.debug(`Redirecting channel ${inboundChannel.name} to voicemail ${inboundNumber.voicemail}`);
        void inboundChannel.setChannelVar({ variable: 'MESSAGE', value: inboundNumber.message });
        void inboundChannel.continueInDialplan({
          context: config.voicemail.context,
          extension: inboundNumber.voicemail,
          priority: 1
        });
      } catch (err) {
        logger.error(
          `Error while redirecting channel ${inboundChannel.name} to voicemail ${inboundNumber.voicemail}`,
          err
        );
      }
    }
  }
}