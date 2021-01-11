import EventEmitter from 'eventemitter3';
import ObjectID from 'bson-objectid';

import { isNetworkError } from '@/utils/misc';

import Area, {
    AreaCategoriesMap,
    AreaAddData,
    AreaUpdateData,
} from '@/models/Area';

import AreasAPI from '@/api/AreasAPI';
import AreaRepository, { AreaOfflineFlags } from '@/repositories/AreaRepository';
import UserRepository from '@/repositories/UserRepository';

export enum AreaServiceEvent {
    AREA_GET_CATEGORIES_ERROR = 'area-get-categories-error',
    AREA_GET_PAGE_ERROR = 'area-get-page-error',
    AREA_GET_PAGE_NETWORK_ERROR = 'area-get-page-network-error',
    AREA_GET_DETAILS_ERROR = 'area-get-details-error',
    AREA_ADDED = 'area-added',
    AREA_ADD_ERROR = 'area-add-error',
    AREA_UPDATED = 'area-updated',
    AREA_UPDATE_ERROR = 'area-update-error',
    AREA_DELETED = 'area-deleted',
    AREA_DELETE_ERROR = 'area-delete-error',
    OFFLINE_MODIFICATIONS = 'offline-modifications',
    SYNC_DONE = 'sync-done',
}

export default class AreaService {
    public emitter: EventEmitter;
    private areasAPI: AreasAPI;
    private areaRepository: AreaRepository;
    private userRepository: UserRepository;

    constructor(
        areasApi: AreasAPI,
        areaRepository: AreaRepository,
        userRepository: UserRepository,
    ) {
        this.areasAPI = areasApi;
        this.areaRepository = areaRepository;
        this.userRepository = userRepository;
        this.emitter = new EventEmitter();
    }

    async getAreaCategories(): Promise<AreaCategoriesMap | undefined> {
        try {
            const categories = await this.areasAPI.areasGetCategories();
            this.areaRepository.setAreaCategories(categories);
        } catch (err) {
            if (!isNetworkError(err)) {
                this.emitter.emit(AreaServiceEvent.AREA_GET_CATEGORIES_ERROR, err);
                return;
            }
        }

        return this.areaRepository.getAreaCategories();
    }

    getAreaCategoryText(value: number | undefined): string | undefined {
        if (!value && value !== 0) {
            return undefined;
        }

        return this.areaRepository.getAreaCategoryText(value);
    }

    async getOrLoadAreasPage(page = 0, limit = 0, searchText = ''): Promise<Area[] | false> {
        try {
            const areasPage = await this.areasAPI.areasGetPage(page, limit);

            if (page === 0 && !searchText) {
                this.areaRepository.clearAreasDetailsMap();
            }

            if (!areasPage.noItems) {
                return false;
            }

            for (const area of areasPage.items) {
                this.areaRepository.setAreaDetails(area);
            }
        } catch (err) {
            if (isNetworkError(err)) {
                this.emitter.emit(AreaServiceEvent.AREA_GET_PAGE_NETWORK_ERROR);
            } else {
                this.emitter.emit(AreaServiceEvent.AREA_GET_PAGE_ERROR, err);
                return false;
            }
        }

        const areas = this.areaRepository.getAreasPaginated(page, limit, true, searchText);
        if (!areas) {
            return false;
        }

        return areas;
    }

    async getAreaDetails(id: string): Promise<Area | undefined> {
        try {
            const area = await this.areasAPI.areasGetArea(id);

            this.areaRepository.setAreaDetails(area);
        } catch (err) {
            if (!isNetworkError(err)) {
                this.emitter.emit(AreaServiceEvent.AREA_GET_DETAILS_ERROR, err);
                return;
            }
        }

        return this.areaRepository.getAreaDetails(id);
    }

    setAreaDetails(area: Area): void {
        this.areaRepository.setAreaDetails(area);
        this.emitter.emit(AreaServiceEvent.AREA_UPDATED, area);
    }

    async addArea(data: AreaAddData, handleNetworkError = true, emitEvent = true): Promise<Area | undefined> {
        let areaResponse;

        try {
            areaResponse = await this.areasAPI.areasPost(data);
            this.areaRepository.setAreaDetails(areaResponse);
        } catch (err) {
            if (!isNetworkError(err)) {
                this.emitter.emit(AreaServiceEvent.AREA_ADD_ERROR, err);
                throw err;
            }

            if (!handleNetworkError) {
                throw err;
            }

            areaResponse = {
                id: new ObjectID().toHexString(),
                owner: this.userRepository.getLoggedInUser(),
                ...data,
            } as Area;
            this.areaRepository.addAreaOffline(areaResponse);
        }

        const area = this.areaRepository.getAreaDetails(areaResponse.id);

        if (emitEvent) {
            this.emitter.emit(AreaServiceEvent.AREA_ADDED, area);
        }

        if (emitEvent && area && area.offlineFlags) {
            this.emitter.emit(AreaServiceEvent.OFFLINE_MODIFICATIONS);
        }

        return area;
    }

    async updateArea(id: string, data: AreaUpdateData, handleNetworkError = true,
        emitEvent = true): Promise<void> {
        try {
            const areaResponse = await this.areasAPI.areasPatchArea(id, data);
            this.areaRepository.setAreaDetails(areaResponse);
        } catch (err) {
            if (!isNetworkError(err)) {
                this.emitter.emit(AreaServiceEvent.AREA_UPDATE_ERROR, err);
                throw err;
            }

            if (!handleNetworkError) {
                throw err;
            }

            this.areaRepository.updateAreaDetailsOffline(id, data);
        }

        const area = this.areaRepository.getAreaDetails(id);

        if (emitEvent) {
            this.emitter.emit(AreaServiceEvent.AREA_UPDATED, area);
        }

        if (emitEvent && area && area.offlineFlags) {
            this.emitter.emit(AreaServiceEvent.OFFLINE_MODIFICATIONS);
        }
    }

    hasAreaOfflineFlag(area: Area | undefined, flag: number): boolean {
        return area !== undefined && area.offlineFlags !== undefined && !!(area.offlineFlags & flag);
    }

    canDeleteLocallyOnly(id: string): boolean {
        const area = this.areaRepository.getAreaDetails(id);
        return !!area && this.hasAreaOfflineFlag(area, AreaOfflineFlags.ADDED);
    }

    async deleteArea(id: string, handleNetworkError = true, emitEvent = true): Promise<void> {
        let offlineModifications = false;

        try {
            if (!this.canDeleteLocallyOnly(id)) {
                await this.areasAPI.areasDeleteArea(id);
            }

            this.areaRepository.deleteAreaDetails(id);
        } catch (err) {
            if (!isNetworkError(err)) {
                this.emitter.emit(AreaServiceEvent.AREA_DELETE_ERROR, err);
                throw err;
            }

            if (!handleNetworkError) {
                throw err;
            }

            this.areaRepository.deleteAreaDetailsOffline(id);
            offlineModifications = true;
        }

        if (emitEvent) {
            this.emitter.emit(AreaServiceEvent.AREA_DELETED, id);
        }

        if (emitEvent && offlineModifications) {
            this.emitter.emit(AreaServiceEvent.OFFLINE_MODIFICATIONS);
        }
    }

    async syncAreaOfflineChanges(area: Area): Promise<void> {
        const isDeleted = this.hasAreaOfflineFlag(area, AreaOfflineFlags.DELETED);
        const isAdded = this.hasAreaOfflineFlag(area, AreaOfflineFlags.ADDED);
        const isUpdated = this.hasAreaOfflineFlag(area, AreaOfflineFlags.UPDATED);
        let success = false;

        try {
            if (isDeleted) {
                await this.deleteArea(area.id, false, true);
                success = true;
            } else if (isAdded) {
                await this.addArea(area, false, false);
                success = true;
            } else if (isUpdated) {
                await this.updateArea(area.id, area, false, false);
            }
            success = true;
        } catch (err) {}

        if (!success) {
            return;
        }

        if (isUpdated) {
            this.areaRepository.clearAreaDetailsOfflineFlags(area.id);
        } else if (isAdded) {
            await this.deleteArea(area.id);
        }
    }

    async syncOfflineChanges(): Promise<void> {
        const areas = this.areaRepository.getOfflineChangedAreas();

        for (const area of areas) {
            await this.syncAreaOfflineChanges(area);
        }

        this.emitter.emit(AreaServiceEvent.SYNC_DONE);
    }
}
