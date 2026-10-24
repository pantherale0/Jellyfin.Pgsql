import { expect, test } from '@playwright/test';

const session = (pipeline?: unknown, direct = false) => ({
    Id: 'fixture-session-id',
    UserName: 'Fixture admin',
    Client: 'Fixture client',
    DeviceName: 'Fixture device',
    PlayState: { PlayMethod: direct ? 'DirectPlay' : 'Transcode' },
    NowPlayingItem: { Id: 'fixture-item-id', Name: 'Fixture movie', RunTimeTicks: 3_600_000_000 },
    TranscodingInfo: {
        IsVideoDirect: direct,
        IsAudioDirect: direct,
        Container: 'mkv',
        BitRate: 12_000_000,
        VideoCodec: 'h264',
        AudioCodec: 'aac',
        HardwareAccelerationType: 'cuda',
        CompletionPercentage: 37,
        TranscodeReasons: ['VideoCodecNotSupported'],
        ...(pipeline === undefined ? {} : { Pipeline: pipeline }),
    },
});

async function openPlayback(page: import('@playwright/test').Page, value: ReturnType<typeof session>, testLocale?: string) {
    await page.route('**/Sessions', route => route.fulfill({ json: [value] }));
    const query = testLocale ? `?testLocale=${encodeURIComponent(testLocale)}` : '';
    await page.goto(`/e2e/fixtures/transcoding-pipeline.html${query}`);
}

async function openSessionDetails(page: import('@playwright/test').Page, value: ReturnType<typeof session>, testLocale?: string) {
    await openPlayback(page, value, testLocale);
    await page.getByRole('button', { name: 'Details' }).click();
}

test('pipeline graph preserves stage order and shows media, hardware, and edge labels', async ({ page }) => {
    await openSessionDetails(page, session({ Stages: [
        { Type: 'Decode', MediaType: 'Video', Framework: 'Cuda', Name: 'hevc_cuvid', Detail: 'H.265 (HEVC)', IsHardware: true, EdgeLabel: 'p010 3840x2160' },
        { Type: 'Scale', MediaType: 'Video', Framework: 'Cuda', Name: 'scale_cuda', Detail: 'Scale', IsHardware: true, EdgeLabel: 'nv12 1920x1080' },
        { Type: 'Decode', MediaType: 'Audio', Framework: 'Software', Name: 'aac', Detail: 'AAC', IsHardware: false },
        { Type: 'ToneMap', MediaType: 'Video', Framework: 'OpenCl', Name: 'tonemap_opencl', Detail: 'Tone-map', IsHardware: true, EdgeLabel: 'nv12 1920x1080' },
        { Type: 'Encode', MediaType: 'Video', Framework: 'Cuda', Name: 'h264_nvenc', Detail: 'H.264 (AVC)', IsHardware: true, EdgeLabel: 'yuv420p 1920x1080' },
    ] }));

    const stages = page.getByRole('region', { name: 'Transcoding pipeline stages' }).getByRole('list').getByRole('listitem');
    await expect(stages).toHaveCount(5);
    await expect(stages.nth(0)).toContainText('Decode');
    await expect(stages.nth(0)).toContainText('H.265 (HEVC)');
    await expect(stages.nth(0)).toContainText('CUDA');
    await expect(stages.nth(0)).toContainText('Hardware');
    await expect(stages.nth(1)).toContainText('Scale');
    await expect(stages.nth(2)).toContainText('Audio');
    await expect(stages.nth(2)).toContainText('Software');
    await expect(stages.nth(3)).toContainText('Tone-map');
    await expect(stages.nth(4)).toContainText('H.264 (AVC)');
    await expect(stages.nth(2).getByTestId('pipeline-connector')).toBeVisible();
    await expect(stages.nth(4).getByTestId('pipeline-connector')).toHaveCount(0);
    await expect(page.getByTestId('pipeline-connector')).toHaveCount(4);
    await expect(stages.nth(4).getByText('Output')).toBeVisible();
    await expect(stages.nth(4)).toContainText('yuv420p 1920x1080');
    await expect(page.getByText('nv12 1920x1080').first()).toBeVisible();
});

test('pipeline graph keeps unknown stage and framework names visible', async ({ page }) => {
    await openSessionDetails(page, session({ Stages: [
        { Type: 'FutureStage', MediaType: 'Video', Framework: 'CustomAccel', Name: 'colorbalance_custom', Detail: 'Color balance', IsHardware: true },
    ] }));

    const stage = page.getByRole('region', { name: 'Transcoding pipeline stages' }).getByRole('list').getByRole('listitem');
    await expect(stage).toContainText('colorbalance_custom');
    await expect(stage).toContainText('CustomAccel');
    await expect(stage).toContainText('FutureStage');
});

test('pipeline graph localizes fallback labels but preserves unknown server values', async ({ page }) => {
    await openSessionDetails(page, session({ Stages: [
        { Type: 'Unknown', MediaType: false, Framework: '', Name: 'incomplete_stage' },
        null,
        { Type: 'FutureStage', MediaType: 'Video', Framework: 'CustomAccel', Name: 'custom_filter' },
    ] }), 'fr');

    const stages = page.getByRole('region', { name: 'Transcoding pipeline stages' }).getByRole('list').getByRole('listitem');
    await expect(stages.nth(0)).toContainText('Étape inconnue');
    await expect(stages.nth(0)).toContainText('Moteur inconnu');
    await expect(stages.nth(0)).toContainText('Type de média inconnu');
    await expect(stages.nth(1)).toContainText('Étape inconnue');
    await expect(stages.nth(1)).toContainText('Moteur inconnu');
    await expect(stages.nth(2)).toContainText('FutureStage');
    await expect(stages.nth(2)).toContainText('CustomAccel');
});

test('pipeline graph reports unavailable details without hiding the session summary', async ({ page }) => {
    await openSessionDetails(page, session());

    await expect(page.getByText('Pipeline details are not available for this session.')).toBeVisible();
    await expect(page.getByText('h264')).toBeVisible();
    await expect(page.getByText('37%')).toBeVisible();
});

test('pipeline graph treats an empty stage list as unavailable', async ({ page }) => {
    await openSessionDetails(page, session({ Stages: [] }));

    await expect(page.getByText('No pipeline stages were reported.')).toBeVisible();
});

test('pipeline graph treats malformed pipeline data as unavailable', async ({ page }) => {
    await openSessionDetails(page, session({ Stages: 'not-an-array' }));

    await expect(page.getByText('Pipeline details are not available for this session.')).toBeVisible();
});

test('pipeline graph is omitted for direct-play sessions', async ({ page }) => {
    await openSessionDetails(page, session(undefined, true));

    await expect(page.getByRole('region', { name: 'Transcoding pipeline stages' })).toHaveCount(0);
});

test('pipeline graph stacks a long sequence on narrow screens', async ({ page }) => {
    const stages = Array.from({ length: 9 }, (_, index) => ({
        Type: index === 0 ? 'Decode' : index === 8 ? 'Encode' : 'Format',
        MediaType: 'Video',
        Framework: index === 0 || index === 8 ? 'Cuda' : 'Software',
        Name: `stage_${index + 1}`,
        Detail: `Stage ${index + 1}`,
        IsHardware: index === 0 || index === 8,
    }));
    await openSessionDetails(page, session({ Stages: stages }));
    await page.setViewportSize({ width: 390, height: 844 });

    const stageItems = page.getByRole('region', { name: 'Transcoding pipeline stages' }).getByRole('list').getByRole('listitem');
    await expect(stageItems).toHaveCount(9);
    const first = await stageItems.nth(0).boundingBox();
    const second = await stageItems.nth(1).boundingBox();
    if (!first || !second) throw new Error('Pipeline stages are not laid out.');
    expect(second.y).toBeGreaterThan(first.y);
    await expect(stageItems.nth(8)).toContainText('stage_9');
});

test('pipeline graph keeps stage order left to right in RTL layouts', async ({ page }) => {
    await openSessionDetails(page, session({ Stages: [
        { Type: 'Decode', MediaType: 'Video', Framework: 'Software', Name: 'hevc', Detail: 'Decode', IsHardware: false },
        { Type: 'Encode', MediaType: 'Video', Framework: 'Cuda', Name: 'h264_nvenc', Detail: 'Encode', IsHardware: true },
    ] }));
    await page.locator('html').evaluate(element => element.setAttribute('dir', 'rtl'));

    const stages = page.getByRole('region', { name: 'Transcoding pipeline stages' }).getByRole('list').getByRole('listitem');
    const first = await stages.nth(0).locator('.ad-pipeline-node').boundingBox();
    const second = await stages.nth(1).locator('.ad-pipeline-node').boundingBox();
    if (!first || !second) throw new Error('Pipeline stages are not laid out.');
    expect(first.x).toBeLessThan(second.x);
});

test('Transcoding tab opens pipeline details for an active transcode', async ({ page }) => {
    await openPlayback(page, session({ Stages: [
        { Type: 'Decode', MediaType: 'Video', Framework: 'Software', Name: 'hevc', Detail: 'H.265 (HEVC)', IsHardware: false },
        { Type: 'Encode', MediaType: 'Video', Framework: 'Cuda', Name: 'h264_nvenc', Detail: 'H.264 (AVC)', IsHardware: true },
    ] }));
    await page.getByRole('button', { name: 'Transcoding', exact: true }).click();

    const details = page.getByRole('button', { name: 'Details' });
    await expect(details).toHaveCount(1);
    await details.click();
    await expect(page.getByRole('region', { name: 'Transcoding pipeline stages' })).toBeVisible();
});
