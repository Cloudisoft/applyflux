import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { employerLink, extractJobs, siteOf } from '../src/extract';

const page = (html: string, url: string) => new JSDOM(html, { url }).window.document;

describe('Save to ApplyFlux: reading the jobs on the page', () => {
  it('LinkedIn search results: every visible card plus the open job', () => {
    const url = 'https://www.linkedin.com/jobs/search/?keywords=qa&currentJobId=4012345678';
    const doc = page(`
      <ul>
        <li data-occludable-job-id="4012345678"><a class="job-card-list__title--link" href="/jobs/view/4012345678/"><strong>Senior QA Analyst</strong></a>
          <div class="artdeco-entity-lockup__subtitle">Acme Health</div><ul class="job-card-container__metadata-wrapper"><li>United States (Remote)</li></ul></li>
        <li data-occludable-job-id="4099999999"><a class="job-card-list__title--link" href="/jobs/view/4099999999/"><strong>QA Automation Engineer</strong></a>
          <div class="artdeco-entity-lockup__subtitle">Beta Corp</div><ul class="job-card-container__metadata-wrapper"><li>Austin, TX</li></ul></li>
      </ul>
      <div class="job-details-jobs-unified-top-card__job-title"><h1>Senior QA Analyst</h1></div>
      <div class="job-details-jobs-unified-top-card__company-name"><a>Acme Health</a></div>
      <div id="job-details">Test pharmacy claims systems.</div>`, url);
    const r = extractJobs(doc, url);
    expect(r.site).toBe('linkedin');
    expect(r.detail).toMatchObject({ url: 'https://www.linkedin.com/jobs/view/4012345678/', title: 'Senior QA Analyst', company: 'Acme Health', description: 'Test pharmacy claims systems.' });
    expect(r.list.map((j) => [j.title, j.company, j.location])).toEqual([
      ['Senior QA Analyst', 'Acme Health', 'United States (Remote)'],
      ['QA Automation Engineer', 'Beta Corp', 'Austin, TX'],
    ]);
  });

  it('Indeed job page and result cards', () => {
    const url = 'https://www.indeed.com/jobs?q=qa+analyst&vjk=abc123';
    const doc = page(`
      <div class="job_seen_beacon"><h2 class="jobTitle"><a data-jk="abc123"><span title="QA Analyst">QA Analyst</span></a></h2>
        <span data-testid="company-name">Gamma Inc</span><div data-testid="text-location">Remote</div></div>
      <h1 data-testid="jobsearch-JobInfoHeader-title">QA Analyst - job post</h1>
      <div data-testid="inlineHeader-companyName">Gamma Inc</div><div data-testid="inlineHeader-companyLocation">Remote</div>
      <div id="jobDescriptionText">Manual and automated testing.</div>`, url);
    const r = extractJobs(doc, url);
    expect(r.detail).toMatchObject({ url: 'https://www.indeed.com/viewjob?jk=abc123', title: 'QA Analyst', company: 'Gamma Inc', location: 'Remote' });
    expect(r.list).toEqual([{ url: 'https://www.indeed.com/viewjob?jk=abc123', title: 'QA Analyst', company: 'Gamma Inc', location: 'Remote' }]);
  });

  it('MyGreenhouse: links straight to Greenhouse application pages', () => {
    const url = 'https://my.greenhouse.io/jobs/search';
    const doc = page(`<ul><li class="job-card"><a href="https://job-boards.greenhouse.io/acmehealth/jobs/501">Senior QA Analyst</a><span class="company-name">Acme Health</span><span class="location">Remote</span></li></ul>`, url);
    const r = extractJobs(doc, url);
    expect(r.site).toBe('mygreenhouse');
    expect(r.list).toEqual([{ url: 'https://job-boards.greenhouse.io/acmehealth/jobs/501', title: 'Senior QA Analyst', company: 'Acme Health', location: 'Remote' }]);
  });

  it('any career site with standard JobPosting markup', () => {
    const url = 'https://careers.example.com/jobs/42';
    const doc = page(`<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Test Engineer', hiringOrganization: { name: 'Example Co' }, jobLocation: { address: { addressLocality: 'Denver', addressRegion: 'CO', addressCountry: 'US' } }, description: '<p>Write <b>tests</b>.</p>' })}</script>`, url);
    const r = extractJobs(doc, url);
    expect(siteOf(url)).toBe('other');
    expect(r.detail).toMatchObject({ url, title: 'Test Engineer', company: 'Example Co', location: 'Denver, CO, US', description: 'Write tests .' });
  });

  it('finds nothing on pages without jobs (no guessing)', () => {
    const url = 'https://www.linkedin.com/jobs/';
    expect(extractJobs(page('<h1>Welcome</h1>', url), url)).toMatchObject({ detail: null, list: [] });
  });
});

describe('employer application links', () => {
  it('unwraps job-board redirect links and rejects links that stay on the job board', () => {
    const base = 'https://www.linkedin.com/jobs/view/1/';
    expect(employerLink('https://www.linkedin.com/jobs/view/externalApply/1?url=https%3A%2F%2Facme.wd5.myworkdayjobs.com%2Fen-US%2Fcareers%2Fjob%2FQA_123', base)).toBe('https://acme.wd5.myworkdayjobs.com/en-US/careers/job/QA_123');
    expect(employerLink('/jobs/view/2/', base)).toBeNull();
    expect(employerLink('javascript:alert(1)', base)).toBeNull();
  });
  it('reads the hidden apply link on a LinkedIn job page', () => {
    const url = 'https://www.linkedin.com/jobs/view/4012345678/';
    const doc = page(`<h1 class="top-card-layout__title">QA Analyst</h1><a class="topcard__org-name-link">Acme</a>
      <code id="applyUrl" style="display:none"><!--"https://www.linkedin.com/jobs/view/externalApply/4012345678?url=https%3A%2F%2Fjob-boards.greenhouse.io%2Facme%2Fjobs%2F9"--></code>`, url);
    expect(extractJobs(doc, url).detail?.applyUrl).toBe('https://job-boards.greenhouse.io/acme/jobs/9');
  });
});

