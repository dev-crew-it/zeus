import stores from '../stores/Stores';
import TransactionRequest from '../models/TransactionRequest';
import OpenChannelRequest from '../models/OpenChannelRequest';
import VersionUtils from '../utils/VersionUtils';
import Base64Utils from '../utils/Base64Utils';
import { Hash as sha256Hash } from 'fast-sha256';
import BigNumber from 'bignumber.js';
import ReactNativeBlobUtil from 'react-native-blob-util';

export default class CLNRest {
    auth = '';

    /* Make the URL starting from the call request */
    getURL = (
        host: string,
        port: string | number,
        route: string,
        ws?: boolean
    ) => {
        const hostPath = host.includes('://') ? host : `https://${host}`;
        let baseUrl = `${hostPath}${port ? ':' + port : ''}`;

        if (ws) {
            baseUrl = baseUrl.replace('https', 'wss').replace('http', 'ws');
        }

        if (baseUrl[baseUrl.length - 1] === '/') {
            baseUrl = baseUrl.slice(0, -1);
        }

        return `${baseUrl}/v1/${route}`;
    };

    call = (route: string, params?: any) => {
        const { host, macaroonHex, port, certVerification } =
            stores.settingsStore;

        const headers = {
            Rune: macaroonHex
        };

        const url = this.getURL(host, port, route);

        return ReactNativeBlobUtil.config({
            trusty: !certVerification
        })
            .fetch('POST', url, headers, JSON.stringify(params))
            .then((response) => {
                return response.json();
            })
            .catch((error) => {
                console.error('Error:', error);
                throw error;
            });
    };

    supports = (
        minVersion: string,
        eosVersion?: string,
        minApiVersion?: string
    ) => {
        const { nodeInfo } = stores.nodeInfoStore;
        const { version, api_version } = nodeInfo;
        const { isSupportedVersion } = VersionUtils;
        if (minApiVersion) {
            return (
                isSupportedVersion(version, minVersion, eosVersion) &&
                isSupportedVersion(api_version, minApiVersion)
            );
        }
        return isSupportedVersion(version, minVersion, eosVersion);
    };

    getTransactions = () =>
        this.call('listfunds').then((data: any) => ({
            transactions: data.outputs
        }));
    getChannels = () =>
        this.call('listpeerchannels').then((data: any) => {
            const formattedChannels: any[] = [];
            data.forEach((channel: any) => {
                if (
                    channel.state === 'ONCHAIN' ||
                    channel.state === 'CLOSED' ||
                    channel.state === 'CHANNELD_AWAITING_LOCKIN'
                )
                    return;

                // CLN v23.05 msat deprecations
                const to_us_msat =
                    channel.to_us ||
                    channel.to_us_msat ||
                    channel.msatoshi_to_us ||
                    0;
                const total_msat =
                    channel.total ||
                    channel.total_msat ||
                    channel.msatoshi_total ||
                    0;
                const out_fulfilled_msat =
                    channel.out_fulfilled ||
                    channel.out_fulfilled_msat ||
                    channel.out_msatoshi_fulfilled ||
                    0;
                const in_fulfilled_msat =
                    channel.in_fulfilled ||
                    channel.in_fulfilled_msat ||
                    channel.in_msatoshi_fulfilled ||
                    0;
                const our_reserve_msat =
                    channel.our_reserve ||
                    channel.our_reserve_msat ||
                    channel.our_channel_reserve_satoshis ||
                    0;
                const their_reserve_msat =
                    channel.their_reserve ||
                    channel.their_reserve_msat ||
                    channel.their_channel_reserve_satoshi ||
                    0;

                formattedChannels.push({
                    active: channel.peer_connected,
                    remote_pubkey: channel.peer_id,
                    channel_point: channel.funding_txid,
                    chan_id: channel.channel_id,
                    alias: '<MISSING>',
                    capacity: Number(total_msat / 1000).toString(),
                    local_balance: Number(to_us_msat / 1000).toString(),
                    remote_balance: Number(
                        (total_msat - to_us_msat) / 1000
                    ).toString(),
                    total_satoshis_sent: Number(
                        out_fulfilled_msat / 1000
                    ).toString(),
                    total_satoshis_received: Number(
                        in_fulfilled_msat / 1000
                    ).toString(),
                    num_updates: (
                        channel.in_payments_offered +
                        channel.out_payments_offered
                    ).toString(),
                    csv_delay: channel.our_to_self_delay,
                    private: channel.private,
                    local_chan_reserve_sat: Number(
                        our_reserve_msat / 1000
                    ).toString(),
                    remote_chan_reserve_sat: Number(
                        their_reserve_msat / 1000
                    ).toString(),
                    close_address: channel.close_to_addr
                });
            });

            return {
                channels: formattedChannels
            };
        });
    getBlockchainBalance = () =>
        this.call('listfunds').then(({ outputs }: any) => {
            console.log('getBlockchainBalance', outputs);
            const unconf = outputs
                .filter((o: any) => o.status !== 'confirmed')
                .reduce((acc: any, o: any) => acc + o.value, 0);
            const conf = outputs
                .filter((o: any) => o.status === 'confirmed')
                .reduce((acc: any, o: any) => acc + o.value, 0);

            return {
                total_balance: conf + unconf,
                confirmed_balance: conf,
                unconfirmed_balance: unconf
            };
        });
    getLightningBalance = () =>
        this.call('listfunds').then(({ channels }: any) => {
            console.log('getLightningBalance', channels);
            let resp = {
                balance: channels
                    .filter((o: any) => o.state === 'CHANNELD_NORMAL')
                    .reduce((acc: any, o: any) => acc + o.our_amount_msat, 0),
                pending_open_balance: channels
                    .filter((o: any) => o.state === 'CHANNELD_AWAITING_LOCKIN')
                    .reduce((acc: any, o: any) => acc + o.our_amount_msat, 0)
            };
            console.log('getLightningBalance', resp);
        });
    sendCoins = (data: TransactionRequest) => {
        let request: any;
        if (data.utxos) {
            request = {
                address: data.addr,
                feeRate: `${Number(data.sat_per_vbyte) * 1000}perkb`,
                satoshis: data.amount,
                utxos: data.utxos
            };
        } else {
            request = {
                address: data.addr,
                feeRate: `${Number(data.sat_per_vbyte) * 1000}perkb`,
                satoshis: data.amount
            };
        }
        // FIXME(vincezopalazzo) check the request body
        return this.call('withdraw', request);
    };
    getMyNodeInfo = () => this.call('getinfo');
    getInvoices = () => this.call('listinvoices');
    createInvoice = (data: any) =>
        this.call('invoice', {
            description: data.memo,
            label: 'zeus.' + Math.random() * 1000000,
            amount_msat: Number(data.value) * 1000,
            expiry: Number(data.expiry),
            exposeprivatechannels: true
        });
    getPayments = () =>
        this.call('listpays').then((data: any) => ({
            payments: data.pays
        }));
    getNewAddress = () => this.call('newaddr');
    openChannelSync = (data: OpenChannelRequest) => {
        let request: any;
        const feeRate = `${new BigNumber(data.sat_per_vbyte)
            .times(1000)
            .toString()}perkb`;
        if (data.utxos && data.utxos.length > 0) {
            request = {
                id: data.id,
                satoshis: data.satoshis,
                feeRate,
                announce: !data.privateChannel ? 'true' : 'false',
                minfConf: data.min_confs,
                utxos: data.utxos
            };
        } else {
            request = {
                id: data.id,
                satoshis: data.satoshis,
                feeRate,
                announce: !data.privateChannel ? 'true' : 'false',
                minfConf: data.min_confs
            };
        }

        // FIXME(vincezopalazzo) check the request body
        return this.call('fundchannel', request);
    };
    connectPeer = (data: any) =>
        this.call('connect', {
            id: `${data.addr.pubkey}@${data.addr.host}`
        });
    // FIXME: this is not supported?
    decodePaymentRequest = (urlParams?: Array<string>) =>
        this.call('decode', { bolt11: urlParams[0] });
    payLightningInvoice = (data: any) =>
        this.call('pay', {
            invoice: data.payment_request,
            amount: Number(data.amt && data.amt * 1000),
            maxfeepercent: data.max_fee_percent
        });
    sendKeysend = (data: any) =>
        this.call('keysend', {
            pubkey: data.pubkey,
            amount: Number(data.amt && data.amt * 1000),
            maxfeepercent: data.max_fee_percent
        });
    closeChannel = (urlParams?: Array<string>) =>
        //FIXME check the URL params
        this.call(`close`, { id: urlParams[0] });
    getNodeInfo = () => this.call('getinfo');
    getFees = () =>
        // FIXME: check the API, in the recent version of cln this is changed
        this.call('estimatedfees').then(({ feeCollected }: any) => ({
            total_fee_sum: feeCollected / 1000
        }));
    setFees = (data: any) =>
        this.call('setchannelfee', {
            id: data.global ? 'all' : data.channelId,
            base: data.base_fee_msat,
            ppm: data.fee_rate
        });
    getRoutes = () => true;
    // FIXME: return just the outputs, inside the array?
    getUTXOs = () => this.call('listfunds');
    signMessage = (message: string) =>
        this.call('signmessage', {
            message
        });
    // FIXME: check this API, I do not remember what is the name of this API
    verifyMessage = (data: any) =>
        this.call('checkMessage', {
            /* Fill the body here */
        });
    lnurlAuth = async (r_hash: string) => {
        const signed = await this.signMessage(r_hash);
        return {
            signature: new sha256Hash()
                .update(Base64Utils.stringToUint8Array(signed.signature))
                .digest()
        };
    };

    // BOLT 12 / Offers
    listOffers = () => this.call('listoffers');
    createOffer = ({
        description,
        label,
        singleUse
    }: {
        description?: string;
        label?: string;
        singleUse?: boolean;
    }) =>
        this.call('offer', {
            amount: 'any',
            description,
            label,
            single_use: singleUse || false
        });
    disableOffer = ({ offer_id }: { offer_id: string }) =>
        this.call('disableoffer', { id: offer_id });
    fetchInvoiceFromOffer = async (bolt12: string, amountSatoshis: string) => {
        return await this.call('fetchinvoice', {
            offer: bolt12,
            msatoshi: Number(amountSatoshis) * 1000,
            timeout: 60
        });
    };

    supportsMessageSigning = () => true;
    supportsLnurlAuth = () => true;
    supportsOnchainSends = () => true;
    supportsOnchainReceiving = () => true;
    supportsLightningSends = () => true;
    supportsKeysend = () => true;
    supportsChannelManagement = () => true;
    supportsPendingChannels = () => false;
    supportsMPP = () => false;
    supportsAMP = () => false;
    supportsCoinControl = () => this.supports('v0.8.2', undefined, 'v0.4.0');
    supportsChannelCoinControl = () =>
        this.supports('v0.8.2', undefined, 'v0.4.0');
    supportsHopPicking = () => false;
    supportsAccounts = () => false;
    supportsRouting = () => true;
    supportsNodeInfo = () => true;
    singleFeesEarnedTotal = () => true;
    supportsAddressTypeSelection = () => false;
    supportsTaproot = () => false;
    supportsBumpFee = () => false;
    supportsLSPs = () => false;
    supportsNetworkInfo = () => false;
    supportsSimpleTaprootChannels = () => false;
    supportsCustomPreimages = () => false;
    supportsSweep = () => true;
    supportsOnchainBatching = () => false;
    supportsChannelBatching = () => false;
    supportsLSPS1customMessage = () => false;
    supportsLSPS1rest = () => true;
    supportsOffers = async () => {
        const res = await this.call('listconfigs');
        const supportsOffers: boolean = res['experimental-offers'] || false;
        return supportsOffers;
    };
    isLNDBased = () => false;
}
